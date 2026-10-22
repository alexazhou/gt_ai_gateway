import { describe, it, expect, vi } from "vitest";
import abortTimeoutUtil from "../../../src/util/abortTimeoutUtil";
import { FailedCode } from "../../../src/constants";

const { TimeoutAbortController, isTaggedError, describeError } = abortTimeoutUtil;

/**
 * `TimeoutAbortController` 是「客户端断开」这条链路的唯一入口：
 * `senderService` 把 `c.req.raw.signal` 传进来，这里再和上游超时合成一个中止信号。
 *
 * 为什么要单独测：worker 本地（`wrangler dev`）不会把客户端断开传播到 `c.req.raw.signal`，
 * 所以 `tests/api/ai/*` 里的端到端断开用例在 worker 下观测不到 client_disconnected
 * （见 ISSUES.md P2-23）。本文件用「显式中止信号」把这段逻辑在两种模式下都钉死：
 * 信号一断，就必须产出带 CLIENT_DISCONNECTED 标记的 TaggedError，文案可读、不带裸 AbortError。
 */
describe("TimeoutAbortController — 客户端断开 / 上游超时口径", () => {
    it("客户端信号中止 → 打 CLIENT_DISCONNECTED 标记，文案可读", async () => {
        const clientCtrl = new AbortController();
        const ctrl = new TimeoutAbortController(0, clientCtrl.signal);
        const aborted = new Promise<unknown>((resolve) => {
            ctrl.signal.addEventListener("abort", () => resolve(ctrl.signal.reason));
        });

        clientCtrl.abort();

        const reason = await aborted;
        expect(ctrl.signal.aborted).toBe(true);
        expect(isTaggedError(reason)).toBe(true);
        expect((reason as any).failedCode).toBe(FailedCode.CLIENT_DISCONNECTED);
        expect(describeError(reason as Error)).toContain("客户端断开");
        expect(describeError(reason as Error)).not.toContain("AbortError");
        ctrl.dispose();
    });

    it("固定超时到点 → 打 UPSTREAM_TIMEOUT 标记", async () => {
        const ctrl = new TimeoutAbortController(20);
        const aborted = new Promise<unknown>((resolve) => {
            ctrl.signal.addEventListener("abort", () => resolve(ctrl.signal.reason));
        });

        const reason = await aborted;
        expect((reason as any).failedCode).toBe(FailedCode.UPSTREAM_TIMEOUT);
        expect(describeError(reason as Error)).toContain("超时");
        ctrl.dispose();
    });

    /**
     * 缺陷看门狗（ISSUES.md P2-24）：`abortWith()` 没有"先到先得"守卫，
     * 客户端断开先到之后，后续到点的固定超时仍会把 `tagged` 改写成 UPSTREAM_TIMEOUT，
     * 失败归因被污染。修好后本用例会转红，届时把 it.fails 改回 it。
     */
    it.fails("超时与断开竞争时，先到的一方赢（不会双写标记）", async () => {
        const clientCtrl = new AbortController();
        const ctrl = new TimeoutAbortController(1000, clientCtrl.signal);

        clientCtrl.abort();
        const first = ctrl.getTaggedError() as any;
        expect(first?.failedCode).toBe(FailedCode.CLIENT_DISCONNECTED);

        // 再等一会，确认定时器不会把标记改写成 UPSTREAM_TIMEOUT
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect((ctrl.getTaggedError() as any)?.failedCode).toBe(FailedCode.CLIENT_DISCONNECTED);
        expect(ctrl.signal.reason).toBe(first);
        ctrl.dispose();
    });

    it("传入已中止的客户端信号 → 构造完即为中止态（断开早于 fetch 的场景）", () => {
        const clientCtrl = new AbortController();
        clientCtrl.abort();

        const ctrl = new TimeoutAbortController(0, clientCtrl.signal);
        expect(ctrl.signal.aborted).toBe(true);
        expect((ctrl.getTaggedError() as any)?.failedCode).toBe(FailedCode.CLIENT_DISCONNECTED);
        ctrl.dispose();
    });

    it("没设超时且客户端没断 → 不会自己中止", async () => {
        const clientCtrl = new AbortController();
        const ctrl = new TimeoutAbortController(0, clientCtrl.signal);

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(ctrl.signal.aborted).toBe(false);
        expect(ctrl.getTaggedError()).toBeNull();
        ctrl.dispose();
    });

    it("dispose 可重复调用，并解除客户端信号监听（不泄漏回调）", () => {
        const clientCtrl = new AbortController();
        const spy = vi.spyOn(clientCtrl.signal, "removeEventListener");
        const ctrl = new TimeoutAbortController(0, clientCtrl.signal);

        ctrl.dispose();
        ctrl.dispose();
        // 注释里承诺"幂等"，实现上重复调用会再 removeEventListener 一次（无害），
        // 这里只保证调用不抛错且监听确实被移除
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);

        // dispose 之后客户端再断开，也不该再改动这个控制器
        clientCtrl.abort();
        expect(ctrl.getTaggedError()).toBeNull();
        expect(ctrl.signal.aborted).toBe(false);
    });
});
