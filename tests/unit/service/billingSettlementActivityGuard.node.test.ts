import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SQLiteAdapter } from "../../../src/util/dbAdapterUtil";
import billingSettlementService from "../../../src/service/billingSettlementService";
import ormService from "../../../src/service/ormService";
import requestActivityManager from "../../../src/manager/requestActivityManager";
import recordManager from "../../../src/manager/recordManager";
import { SgRecordStatus, RequestActivityStage } from "../../../src/constants";

/**
 * #332 回归：结算侧给「已删 record」补写孤儿活动行
 *
 * 现场（#326 取证）：流式请求的后台结算走 `waitUntil`，要等上游空闲超时（~180s）才 fire；
 * 而 `record` 可能早已被删除 / 被 truncate 清掉。结算里写 `request_activity` 原本是无条件 UPSERT、
 * 不校验 record 还在不在 ⇒ 给已删记录补回一行孤儿活动（`recordDelete.test.ts` 的全表
 * `COUNT(*)` 因此偶发 +1，红成 `expected 1 to be +0`）。
 *
 * 本文件钉的就是这条守卫：**record 不存在 ⇒ 不写活动行，且留一条可诊断日志**；
 * record 存在时行为不变（活动行照写）。
 *
 * 夹具说明：写入走**真库**（better-sqlite3 内存库，`runAtomically` 直接落表，断言数的是
 * `request_activity` 真实行数）；只有「record 是否还在」这一次读用 spy 注入
 * （记录存在性是 `record` 表的查，本文件不引 sutando 全局连接，避免把单测变成集成测试）。
 * 因此摘掉守卫后，UPSERT 会真的插进真表 ⇒ 断言必然红，判据不是恒真。
 */
describe("#332 结算侧活动写入的存在性守卫（better-sqlite3 真库）", () => {
    let db: Database.Database;
    let adapter: SQLiteAdapter;

    const RECORD_ID = 42;
    const USER_ID = 7;
    const INITIAL_BALANCE = 1_000_000;

    /** 注入「record 是否还在」这一次读：true = 还在，false = 已被删 */
    function mockRecordExists(exists: boolean): void {
        vi.spyOn(recordManager, "findById").mockResolvedValue(
            exists ? ({ id: RECORD_ID } as any) : null,
        );
    }

    /**
     * 模拟「record 已被删」：真表删掉 record 行（让扣费守卫的
     * `(SELECT status FROM record WHERE id=?) <> 'success'` 真的读到 NULL），
     * 同时把存在性读注入成 null。两者必须一致，否则测的就不是现场状态。
     */
    function deleteRecordRow(): void {
        db.prepare("DELETE FROM record WHERE id = ?").run(RECORD_ID);
        mockRecordExists(false);
    }

    function activityRows(recordId: number = RECORD_ID): Record<string, any>[] {
        return db.prepare("SELECT * FROM request_activity WHERE record_id = ?").all(recordId) as Record<string, any>[];
    }

    function activityCount(): number {
        const row = db.prepare("SELECT COUNT(*) AS n FROM request_activity").get() as { n: number };
        return row.n;
    }

    function balanceOf(): number {
        const row = db.prepare("SELECT balance FROM user WHERE id = ?").get(USER_ID) as { balance: number };
        return row.balance;
    }

    /** 一次带 RESULT 活动的结算（等价于 #326 里 record_id=40 的那次迟到结算） */
    function settleWithActivity() {
        return billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.FAILED,
            cost: 0,
            endAt: new Date(),
            chargeUserId: null,
            activity: {
                stage: RequestActivityStage.RESULT,
                message: "上游超时（upstream_timeout）",
            },
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
            CREATE TABLE request_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id INTEGER NOT NULL UNIQUE,
                activities TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
            );
        `);
        db.prepare("INSERT INTO record (id, status, cost) VALUES (?, ?, ?)").run(RECORD_ID, "processing", 0);
        db.prepare("INSERT INTO user (id, balance) VALUES (?, ?)").run(USER_ID, INITIAL_BALANCE);

        adapter = new SQLiteAdapter(db);
        (ormService as any)._dbAdapter = adapter;

        // 读到「已有活动」的路径也走真库（不存在时返回 null，追加逻辑照常）
        vi.spyOn(requestActivityManager, "findByRecordId").mockResolvedValue(null as any);
    });

    afterEach(() => {
        db.close();
        (ormService as any)._dbAdapter = null;
        vi.restoreAllMocks();
    });

    it("正：record 仍在时照旧写入活动行（守卫不误伤正常结算）", async () => {
        mockRecordExists(true);

        await settleWithActivity();

        const rows = activityRows();
        expect(rows).toHaveLength(1);
        const activities = JSON.parse(rows[0].activities) as { stage: string; message: string }[];
        expect(activities).toHaveLength(1);
        expect(activities[0].stage).toBe(RequestActivityStage.RESULT);
        expect(activities[0].message).toContain("upstream_timeout");
    });

    it("反：record 已被删除时不写活动行，且留一条可诊断日志（核心判据）", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        deleteRecordRow();

        await settleWithActivity();

        // ① 没有孤儿活动行 —— 全表 COUNT 保持 0（正是 recordDelete 断言的形式）
        expect(activityCount()).toBe(0);
        // ② 不是静默吞掉：日志里能指认 record id 与阶段
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0][0]);
        expect(message).toContain(String(RECORD_ID));
        expect(message).toContain("已被删除");
        expect(message).toContain(RequestActivityStage.RESULT);
    });

    it("反：record 已删时结算本身不抛错（后台 waitUntil 链路不能被守卫打断）", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        deleteRecordRow();

        await expect(settleWithActivity()).resolves.toEqual({ cost: 0 });
        expect(activityCount()).toBe(0);
    });

    it("record 已删时不扣费、不留活动行（余额与活动表都干净）", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        deleteRecordRow();

        await billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.SUCCESS,
            cost: 0.01,
            endAt: new Date(),
            chargeUserId: USER_ID,
            activity: { stage: RequestActivityStage.RESULT, message: "结算" },
        });

        expect(balanceOf()).toBe(INITIAL_BALANCE);
        expect(activityCount()).toBe(0);
    });

    it("同一 record 重复结算（waitUntil 重试）活动行仍只有 1 行（幂等 UPSERT 不变）", async () => {
        mockRecordExists(true);

        await settleWithActivity();
        await settleWithActivity();

        const rows = activityRows();
        expect(rows).toHaveLength(1);
    });

    it("存在时写入 / 删除后跳过：同一份代码下两条路径可由同一条判据区分", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        mockRecordExists(true);
        await settleWithActivity();                 // record 在 → 写
        expect(activityCount()).toBe(1);

        // 模拟删除路径：记录与活动行一起被清掉
        db.prepare("DELETE FROM request_activity WHERE record_id = ?").run(RECORD_ID);
        expect(activityCount()).toBe(0);

        vi.restoreAllMocks();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(requestActivityManager, "findByRecordId").mockResolvedValue(null as any);
        deleteRecordRow();

        await settleWithActivity();                 // 迟到结算 → 不写
        expect(activityCount()).toBe(0);
    });
});
