import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SQLiteAdapter, D1Adapter } from "../../../src/util/dbAdapterUtil";
import billingSettlementService from "../../../src/service/billingSettlementService";
import billingUtil from "../../../src/util/protocolUtil/billingUtil";
import ormService from "../../../src/service/ormService";
import recordService from "../../../src/service/recordService";
import configService from "../../../src/service/configService";
import { SgRecordStatus } from "../../../src/constants";

/**
 * P0-4 回归：记录结算 + 扣费的原子性（node / better-sqlite3 真库）
 *
 * 契约（与阿张的补丁一致）：
 * - 「record 收尾 + 扣费」在同一原子批里提交：要么都生效，要么都不留痕；
 * - 扣费语句带 `(SELECT status FROM record WHERE id = ?) <> 'success'` 守卫，且排在 record UPDATE 之前
 *   → 同一 record 重复结算只扣一次；
 * - 事务内不读配置（isModuleBillingEnabled 由调用方在事务外取）。
 * 注：activity 是审计日志，按补丁属于 best-effort（在事务外），本文件不断言其原子性。
 */
describe("P0-4 结算原子性（better-sqlite3 真库）", () => {
    let db: Database.Database;
    let adapter: SQLiteAdapter;

    const RECORD_ID = 42;
    const USER_ID = 7;
    const INITIAL_BALANCE = 1_000_000; // 1 元 = 1e6 微元

    function balanceOf(userId: number = USER_ID): number {
        const row = db.prepare("SELECT balance FROM user WHERE id = ?").get(userId) as { balance: number };
        return row.balance;
    }

    function recordOf(recordId: number = RECORD_ID): Record<string, any> {
        return db.prepare("SELECT * FROM record WHERE id = ?").get(recordId) as Record<string, any>;
    }

    function settleSuccess(cost: number, chargeUserId: number | null = USER_ID) {
        return billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.SUCCESS,
            usage: JSON.stringify({ prompt_tokens: 10, completion_tokens: 20 }),
            cost,
            endAt: new Date(),
            firstTokenLatency: 123,
            chargeUserId,
        });
    }

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(`
            CREATE TABLE record (
                id INTEGER PRIMARY KEY,
                status TEXT,
                cost INTEGER,
                usage TEXT,
                failed_code TEXT,
                end_at TEXT,
                first_token_latency INTEGER,
                updated_at TEXT
            );
            CREATE TABLE user (
                id INTEGER PRIMARY KEY,
                balance INTEGER,
                updated_at TEXT
            );
        `);
        db.prepare("INSERT INTO record (id, status, cost) VALUES (?, ?, ?)").run(RECORD_ID, "processing", 0);
        db.prepare("INSERT INTO user (id, balance) VALUES (?, ?)").run(USER_ID, INITIAL_BALANCE);

        adapter = new SQLiteAdapter(db);
        (ormService as any)._dbAdapter = adapter;
    });

    afterEach(() => {
        db.close();
        (ormService as any)._dbAdapter = null;
        vi.restoreAllMocks();
    });

    it("首次结算：record 置 success + 余额按微元精确扣减", async () => {
        const cost = 0.000123; // 123 微元
        await settleSuccess(cost);

        const record = recordOf();
        expect(record.status).toBe("success");
        expect(Number(record.cost)).toBe(billingUtil.toUnits(cost));
        expect(record.first_token_latency).toBe(123);
        expect(record.end_at).toBeTruthy();

        expect(balanceOf()).toBe(INITIAL_BALANCE - 123);
    });

    it("同一 record 重复结算（waitUntil 重试 / 重复 finalize）只扣一次费", async () => {
        const cost = 0.0005;
        await settleSuccess(cost);
        const afterFirst = balanceOf();

        await settleSuccess(cost);
        await settleSuccess(cost);

        // 余额不再变化：守卫读到 record 已是 success
        expect(balanceOf()).toBe(afterFirst);
        expect(balanceOf()).toBe(INITIAL_BALANCE - billingUtil.toUnits(cost));
    });

    it("chargeUserId 为 null（root / 计费关闭 / 失败请求）时不扣费但 record 仍结算", async () => {
        await settleSuccess(0.0009, null);

        expect(recordOf().status).toBe("success");
        expect(balanceOf()).toBe(INITIAL_BALANCE);
    });

    it("失败结算：写 failed_code、cost=0、余额不变", async () => {
        await billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.FAILED,
            cost: 0,
            failedCode: "upstream_error",
            endAt: new Date(),
            chargeUserId: null,
        });

        const record = recordOf();
        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_error");
        expect(Number(record.cost)).toBe(0);
        expect(balanceOf()).toBe(INITIAL_BALANCE);
    });

    it("扣费语句排在 record UPDATE 之前，且带「尚未结算」守卫", async () => {
        const captured: { sql: string; params?: unknown[] }[][] = [];
        const original = adapter.runAtomically.bind(adapter);
        vi.spyOn(adapter, "runAtomically").mockImplementation(async (statements: any) => {
            captured.push(statements);
            return original(statements);
        });

        await settleSuccess(0.01);

        expect(captured).toHaveLength(1);
        const statements = captured[0];
        expect(statements).toHaveLength(2);

        // ① 扣费语句在前（顺序错了幂等守卫就会失效）
        expect(statements[0].sql).toContain("balance = balance -");
        expect(statements[0].sql).toContain("(SELECT COALESCE(status, '') FROM record WHERE id = ?) <> ?");
        // ② 守卫参数必须是 success 状态字面量
        expect(statements[0].params).toEqual([
            billingUtil.toUnits(0.01),
            expect.any(String),
            USER_ID,
            RECORD_ID,
            SgRecordStatus.SUCCESS,
        ]);

        // ③ record 收尾在后
        expect(statements[1].sql).toContain("UPDATE record SET");
        expect(statements[1].sql).toContain("status = ?");
        expect(statements[1].params?.at(-1)).toBe(RECORD_ID);
    });

    it("事务内不读配置（isModuleBillingEnabled 在事务外取）", async () => {
        const configSpy = vi.spyOn(configService, "isModuleBillingEnabled");

        await settleSuccess(0.01);

        // settleRecord 自身不读配置；调用方（responseHandlerService）在事务外读
        expect(configSpy).not.toHaveBeenCalled();
    });

    it("response_data 在事务之前写入（对象存储幂等，不属于同库事务）", async () => {
        const order: string[] = [];
        vi.spyOn(recordService, "storeResponsePayload").mockImplementation(async () => {
            order.push("storePayload");
        });
        vi.spyOn(adapter, "runAtomically").mockImplementation(() => {
            order.push("atomicWrite");
        });

        await billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.SUCCESS,
            cost: 0,
            endAt: new Date(),
            responseData: '{"ok":true}',
            chargeUserId: null,
        });

        expect(order).toEqual(["storePayload", "atomicWrite"]);
    });

    it("批内任一语句失败则整体回滚（钱账一致）", async () => {
        // 直接验证原子原语：第一条成功、第二条失败 → 全部回滚
        expect(() =>
            adapter.runAtomically([
                { sql: "UPDATE user SET balance = balance - ? WHERE id = ?", params: [500, USER_ID] },
                { sql: "UPDATE not_exist_table SET x = 1" },
            ] as any),
        ).toThrow();

        expect(balanceOf()).toBe(INITIAL_BALANCE);
    });
});

/**
 * D1（Cloudflare Workers）路径：用假 db 验证 batch 语义，不依赖 miniflare。
 * 真实 D1 行为由 worker 模式集成用例覆盖。
 */
describe("P0-4 D1 runAtomically 适配", () => {
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
