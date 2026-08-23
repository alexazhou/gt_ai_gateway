import { beforeEach, describe, expect, it } from "vitest";
import rateLimitService from "../../../src/service/rateLimitService";
import memoryRateLimitStore from "../../../src/util/rule/memoryRateLimitStore";
import customError from "../../../src/customError";
import type { RequestContext } from "../../../src/util/rule/types";
import type SgRule from "../../../src/model/sgRule";

const ctx: RequestContext = { user_id: 1, model_id: 2 };

function rule(id: number, config: Record<string, unknown>): SgRule {
    return { id, name: `rule-${id}`, config } as unknown as SgRule;
}

describe("rateLimitService", () => {
    beforeEach(() => {
        memoryRateLimitStore.clear();
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
});
