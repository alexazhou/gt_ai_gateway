import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";

/**
 * P2-10：孤儿记录回收改「分页取 + 单条批量 UPDATE」。
 *
 * 背景：请求中途进程被回收（worker 重启 / 崩溃）时，record 会永久停在 init/processing、
 * end_at 为空 —— 统计里既不算成功也不算失败，一直挂着。回收逻辑要把这类「超时未收尾」的记录
 * 标成 failed + failed_code=recovered_orphan。
 *
 * 批量化后的关键行为（本用例逐条验证）：
 * 1. 一次能吃掉远超一批（200 条）的孤儿，不会只回收第一批就停；
 * 2. 未超过阈值的 processing 记录**不能**被误伤；
 * 3. 幂等：再调一次 recovered=0（已收尾的不会被重复计数/重复写活动）；
 * 4. 回收后 end_at 必须落值（否则又变成「没有结束时间」的脏数据）。
 */

const ORPHAN_COUNT = 250; // > RECOVER_ORPHAN_BATCH(200)，用来验证分页循环
const FRESH_COUNT = 3;

let adminToken: string;
let adminUserId: number;
let tenantId: number;

describe("record 孤儿回收批量化（P2-10）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        // 阈值显式设成 10 分钟：测试库里可能配了很小的值，会把「1 分钟前」的请求也当孤儿
        const cfg = await requestHelper.put("/config.json", { orphan_recover_threshold_ms: "600000" }, adminToken);
        expect(cfg.status).toBe(200);

        const admins = await dbHelper.query<any>("SELECT id, tenant_id FROM user ORDER BY id ASC LIMIT 1");
        adminUserId = admins[0].id;
        tenantId = admins[0].tenant_id ?? 1;
    }, 60000);

    async function insertProcessingRecord(startOffset: string) {
        // 用 SQL 侧时间函数造「N 小时前开始、至今未收尾」，避免用例自己算时区
        await dbHelper.execute(
            `INSERT INTO record (user_id, model_id, status, start_at, end_at, tenant_id, created_at, updated_at)
             VALUES (${adminUserId}, 1, 'processing', datetime('now','localtime','${startOffset}'), NULL, ${tenantId}, datetime('now','localtime'), datetime('now','localtime'))`,
        );
    }

    it("超过一批（200）的孤儿全部被回收，且结束时间落值", async () => {
        for (let i = 0; i < ORPHAN_COUNT; i += 1) {
            await insertProcessingRecord("-2 hours");
        }
        // 新鲜 processing（1 分钟前开始）不该被当成孤儿
        for (let i = 0; i < FRESH_COUNT; i += 1) {
            await insertProcessingRecord("-1 minutes");
        }

        const response = await requestHelper.post("/record/recover-orphans.json", {}, adminToken);
        expect(response.status).toBe(200);
        expect(response.body.recovered, "必须跨批回收，不能只回收第一批 200 条")
            .toBeGreaterThanOrEqual(ORPHAN_COUNT);

        const stillOrphan = await dbHelper.query<any>(
            `SELECT COUNT(*) AS c FROM record
             WHERE status IN ('init','processing') AND end_at IS NULL AND start_at < datetime('now','localtime','-10 minutes')`,
        );
        expect(Number(stillOrphan[0].c), "超阈值的孤儿不该有残留").toBe(0);

        const recovered = await dbHelper.query<any>(
            `SELECT COUNT(*) AS c FROM record
             WHERE status = 'failed' AND failed_code = 'recovered_orphan' AND end_at IS NOT NULL`,
        );
        expect(Number(recovered[0].c)).toBeGreaterThanOrEqual(ORPHAN_COUNT);

        const fresh = await dbHelper.query<any>(
            `SELECT COUNT(*) AS c FROM record
             WHERE status IN ('init','processing') AND start_at >= datetime('now','localtime','-5 minutes')`,
        );
        expect(Number(fresh[0].c), "未超阈值的新请求不能被误判为孤儿").toBe(FRESH_COUNT);
    }, 120000);

    it("重复调用幂等：第二次 recovered=0，记录不会被重复改写", async () => {
        const before = await dbHelper.query<any>(
            `SELECT COUNT(*) AS c FROM record WHERE failed_code = 'recovered_orphan'`,
        );

        const response = await requestHelper.post("/record/recover-orphans.json", {}, adminToken);
        expect(response.status).toBe(200);
        expect(response.body.recovered, "已经收尾的记录不能被二次回收").toBe(0);

        const after = await dbHelper.query<any>(
            `SELECT COUNT(*) AS c FROM record WHERE failed_code = 'recovered_orphan'`,
        );
        expect(Number(after[0].c)).toBe(Number(before[0].c));
    }, 60000);
});
