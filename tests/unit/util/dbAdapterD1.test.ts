import { describe, expect, it, vi } from "vitest";
import { D1Adapter } from "../../../src/util/dbAdapterUtil";

/**
 * D1（Cloudflare Workers）批处理语义：用假 db 钉住「全部语句进同一个 batch、按参数绑定」，
 * 不依赖 miniflare，也不需要真库。真实 D1 行为由 worker 模式集成用例覆盖。
 */
describe("D1Adapter.runAtomically", () => {
    it("全部语句进同一个 batch（隐式事务），并按参数绑定", async () => {
        const bind = vi.fn((...params: unknown[]) => ({ params }));
        const prepare = vi.fn((sql: string) => ({ bind, sql }));
        const batch = vi.fn(async (stmts: unknown[]) => stmts.map(() => ({ success: true })));

        const adapter = new D1Adapter();
        adapter.setDB({ prepare, batch } as any);

        await adapter.runAtomically([
            { sql: "UPDATE user SET balance = balance - ? WHERE id = ?", params: [100, 7] },
            { sql: "UPDATE record SET status = ? WHERE id = ?", params: ["success", 42] },
        ]);

        expect(prepare).toHaveBeenCalledTimes(2);
        expect(batch).toHaveBeenCalledTimes(1);
        expect((batch.mock.calls[0][0] as unknown[]).length).toBe(2);
        expect(bind).toHaveBeenCalledWith(100, 7);
        expect(bind).toHaveBeenCalledWith("success", 42);
    });

    it("batch 抛错时异常向上抛（由调用方兜底 markFailed）", async () => {
        const adapter = new D1Adapter();
        adapter.setDB({
            prepare: () => ({ bind: () => ({}) }),
            batch: async () => {
                throw new Error("D1 batch failed");
            },
        } as any);

        await expect(
            adapter.runAtomically([{ sql: "UPDATE user SET balance = balance - 1 WHERE id = 7" }]),
        ).rejects.toThrow("D1 batch failed");
    });
});
