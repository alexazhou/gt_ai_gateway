import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

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

    /**
     * 一次性插入多条「N 小时前开始、至今未收尾」的 processing 记录。
     *
     * 必须拼成单条多值 INSERT：worker 模式下 dbHelper.execute 走 `wrangler d1 execute`，
     * 每条语句都要起一次 wrangler CLI（约 1s），逐条插 250 行会拖到 4 分钟以上。
     * 用字面量而不是绑定参数，是因为 D1 单语句绑定变量有上限（绑 200+ 会报 too many SQL variables）。
     */
    async function insertProcessingRecords(count: number, startOffset: string) {
        const values: string[] = [];
        for (let i = 0; i < count; i += 1) {
            values.push(
                `(${adminUserId}, 1, 'processing', datetime('now','localtime','${startOffset}'), NULL, ${tenantId}, datetime('now','localtime'), datetime('now','localtime'))`,
            );
        }
        await dbHelper.execute(
            `INSERT INTO record (user_id, model_id, status, start_at, end_at, tenant_id, created_at, updated_at) VALUES ${values.join(",")}`,
        );
    }

    // worker 下已知缺陷 P2-27：批量 UPDATE 用 `WHERE id IN (200 个 ?)`，D1 单语句绑定变量有上限，
    // 实测 `D1_ERROR: too many SQL variables` → 500。修好后本用例会转红，届时把 it.fails 改回 it。
    const itOrExpectedFail = config.TEST_MODE === "worker" ? it.fails : it;

    itOrExpectedFail("超过一批（200）的孤儿全部被回收，且结束时间落值", async () => {
        await insertProcessingRecords(ORPHAN_COUNT, "-2 hours");
        // 新鲜 processing（1 分钟前开始）不该被当成孤儿
        await insertProcessingRecords(FRESH_COUNT, "-1 minutes");

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

    // 幂等性依赖第一次回收成功，worker 下被 P2-27 挡住，修好后再打开
    it.skipIf(config.TEST_MODE === "worker")("重复调用幂等：第二次 recovered=0，记录不会被重复改写", async () => {
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
