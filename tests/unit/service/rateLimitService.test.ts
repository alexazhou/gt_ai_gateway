import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rateLimitService from "../../../src/service/rateLimitService";
import stateStoreService from "../../../src/service/stateStoreService";
import customError from "../../../src/customError";
import { StateStoreUnavailableError, type StateStore } from "../../../src/util/stateStore";
import type { RequestContext } from "../../../src/util/rule/types";
import type SgRule from "../../../src/model/sgRule";

const ctx: RequestContext = { user_id: 1, model_id: 2 };
// 固定时间点，使令牌桶补液/等待时间可精确断言
const BASE = 1_700_000_040_000;

function rule(id: number, config: Record<string, unknown>): SgRule {
    return { id, name: `rule-${id}`, config } as unknown as SgRule;
}

function advance(ms: number): void {
    vi.mocked(Date.now).mockReturnValue(BASE + ms);
}

/**
 * 注入一个「后端不可用」的 StateStore：所有异步方法抛 StateStoreUnavailableError。
 * 用来验证限流链路的 fail-closed（宁可误拒，不可误放）。
 */
function unavailableStore(): StateStore {
    const fail = async (): Promise<never> => {
        throw new StateStoreUnavailableError("injected: backend down");
    };
    return {
        consume: fail,
        incrBy: fail,
        compareAndSet: fail,
        get: fail,
        set: fail,
        delete: fail,
    } as unknown as StateStore;
}

describe("rateLimitService", () => {
    beforeEach(() => {
        // 令牌桶已落在全局 StateStore，测试隔离统一用 stateStoreService.reset()
        stateStoreService.reset();
        vi.spyOn(Date, "now").mockReturnValue(BASE);
    });

    afterEach(() => {
        stateStoreService.reset();
        vi.restoreAllMocks();
    });

    it("passes through when rpm is null or absent", async () => {
        await expect(rateLimitService.checkAndAdmit(rule(1, { rpm: null }), ctx)).resolves.toBeUndefined();
        await expect(rateLimitService.checkAndAdmit(rule(2, {}), ctx)).resolves.toBeUndefined();
        await expect(rateLimitService.checkAndAdmit(rule(3, undefined as any), ctx)).resolves.toBeUndefined();
    });

    it("throws RateLimitError immediately when rpm is 0 (unavailable)", async () => {
        const err = await rateLimitService.checkAndAdmit(rule(1, { rpm: 0 }), ctx).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err.statusCode).toBe(429);
        expect(err.code).toBe("rate_limit_error");
        expect(err.retryAfterSeconds).toBe(60);
    });

    it("allows up to N requests then rejects the (N+1)th", async () => {
        const r = rule(1, { rpm: 2 });
        await expect(rateLimitService.checkAndAdmit(r, ctx)).resolves.toBeUndefined();
        await expect(rateLimitService.checkAndAdmit(r, ctx)).resolves.toBeUndefined();
        const err = await rateLimitService.checkAndAdmit(r, ctx).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err.statusCode).toBe(429);
    });

    it("counts independently per rule", async () => {
        // rule-1 的额度消耗不影响 rule-2
        await rateLimitService.checkAndAdmit(rule(1, { rpm: 1 }), ctx);
        await expect(rateLimitService.checkAndAdmit(rule(2, { rpm: 1 }), ctx)).resolves.toBeUndefined();
        await expect(rateLimitService.checkAndAdmit(rule(2, { rpm: 1 }), ctx)).rejects.toBeInstanceOf(customError.RateLimitError);
    });

    it("propagates failoverEligible flag to the thrown error", async () => {
        const err = await rateLimitService.checkAndAdmit(rule(1, { rpm: 0 }), ctx, { failoverEligible: true }).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err.failoverEligible).toBe(true);

        const noFlag = await rateLimitService.checkAndAdmit(rule(2, { rpm: 0 }), ctx).catch(e => e);
        expect(noFlag.failoverEligible).toBe(false);
    });

    it("computes precise retry-after when throttled on an empty bucket", async () => {
        const r = rule(1, { rpm: 2 });
        await rateLimitService.checkAndAdmit(r, ctx);
        await rateLimitService.checkAndAdmit(r, ctx);
        // 桶空（remaining=0）：补足 1 个令牌需 60s / 2 = 30s
        const err = await rateLimitService.checkAndAdmit(r, ctx).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err.retryAfterSeconds).toBe(30);
    });

    it("retry-after shrinks after partial refill", async () => {
        const r = rule(1, { rpm: 2 });
        await rateLimitService.checkAndAdmit(r, ctx);
        await rateLimitService.checkAndAdmit(r, ctx);
        // 前进 15s：补 0.5 个令牌，还差 0.5 → 15s
        advance(15_000);
        const err = await rateLimitService.checkAndAdmit(r, ctx).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err.retryAfterSeconds).toBe(15);
    });

    // ---- fail-closed：状态后端不可用时宁可误拒，不可误放 ----

    it("StateStore 不可用时 fail-closed：转成 429（Retry-After = 60）", async () => {
        stateStoreService.setStore(unavailableStore());

        const err = await rateLimitService.checkAndAdmit(rule(1, { rpm: 100 }), ctx).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err).not.toBeInstanceOf(StateStoreUnavailableError);
        expect(err.statusCode).toBe(429);
        expect(err.retryAfterSeconds).toBe(60);
        expect(err.message).toContain("unavailable");
    });

    it("StateStore 不可用时的 fail-closed 也保留 failoverEligible 标记", async () => {
        stateStoreService.setStore(unavailableStore());

        const err = await rateLimitService.checkAndAdmit(rule(1, { rpm: 100 }), ctx, { failoverEligible: true }).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err.failoverEligible).toBe(true);
    });

    it("非 StateStoreUnavailableError 的异常原样抛出（不伪装成限流）", async () => {
        const boom = new TypeError("cross-semantic key");
        stateStoreService.setStore({
            consume: async () => {
                throw boom;
            },
        } as unknown as StateStore);

        await expect(rateLimitService.checkAndAdmit(rule(1, { rpm: 100 }), ctx)).rejects.toBe(boom);
    });
});
