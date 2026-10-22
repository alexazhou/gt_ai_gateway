import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import config from "../../config";
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
 *
 * P2-27 补的两类守卫：
 * 5. 活动日志随批量化一起落库（不能「为了绕开 subrequest 配额把日志写丢」）；
 * 6. 反向守卫：活动批量写**失败**时，记录仍被回收且留下 warn 日志（best-effort 语义）。
 */

const ORPHAN_COUNT = 250; // > RECOVER_ORPHAN_BATCH(200)，用来验证分页循环
const FRESH_COUNT = 3;

/** 第一条用例结束时的库内快照，供幂等用例比对（避免在 HTTP 请求前后各起一次 CLI） */
let baseline = { recovered: 0, activities: 0 };

/** request_activity 的原始 DDL：反向守卫用例会先删表注入写入失败，断言完再建回来 */
let activityTableDdl = "";

/**
 * 读取服务端日志（globalSetup 会把 server stdout/stderr 落盘到 app.log）。
 * 只用于「warn 是否留痕」这类无法从接口观测的断言。
 */
function readAppLog(): string {
    const path = join(config.LOG_CONFIG.dir, config.LOG_CONFIG.appLogFile);
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

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

        // 提前抓 request_activity 的建表语句（供反向守卫用例删表后还原）。
        // 放在 beforeAll、在任何 HTTP 请求之前做，避免「CLI 查询紧跟 HTTP」触发
        // wrangler dev 的连接重连竞态（见文件末尾注释）。
        const ddlRows = await dbHelper.query<any>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'request_activity'",
        );
        expect(ddlRows.length, "request_activity 表应存在").toBeGreaterThan(0);
        activityTableDdl = String(ddlRows[0].sql ?? "");
        expect(activityTableDdl.toLowerCase()).toContain("create table");
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

    // P2-27 已修（704be9b）：批量 UPDATE 按 87 个 id 分片（D1 单语句绑定变量上限 100，
    // 3 个赋值参数占 3 → 预算 90 - 3 = 87），活动日志改批量 UPSERT（原来 250 条 = 750 次 D1
    // 往返，会打爆 Worker 的 subrequest 配额，表现成 ECONNRESET 而不是报错）。
    // 原 worker 侧 it.fails 看门狗已转正式断言 —— 两模式跑同一份断言。
    it("超过一批（200）的孤儿全部被回收，且结束时间落值", async () => {
        await insertProcessingRecords(ORPHAN_COUNT, "-2 hours");
        // 新鲜 processing（1 分钟前开始）不该被当成孤儿
        await insertProcessingRecords(FRESH_COUNT, "-1 minutes");

        const response = await requestHelper.post("/record/recover-orphans.json", {}, adminToken);
        expect(response.status).toBe(200);
        expect(response.body.recovered, "必须跨批回收，不能只回收第一批 200 条")
            .toBeGreaterThanOrEqual(ORPHAN_COUNT);

        // 四个口径一次查回：worker 下每条 dbHelper 查询都要起一遍 wrangler CLI（约 1s），
        // 而「连续多次 CLI 之后紧跟的 HTTP 请求」会被 wrangler dev 的连接重连竞态打断
        // （诊断实测：与接口无关，任意接口都会 ECONNRESET；CLI 后等 1s 即恢复 —— 属测量方式
        // 问题，不是产品缺陷）。所以这里合并查询，减少 CLI 次数。
        const summary = await dbHelper.query<any>(
            `SELECT
                (SELECT COUNT(*) FROM record
                  WHERE status IN ('init','processing') AND end_at IS NULL
                    AND start_at < datetime('now','localtime','-10 minutes')) AS still_orphan,
                (SELECT COUNT(*) FROM record
                  WHERE status = 'failed' AND failed_code = 'recovered_orphan'
                    AND end_at IS NOT NULL) AS recovered,
                (SELECT COUNT(*) FROM record
                  WHERE status IN ('init','processing')
                    AND start_at >= datetime('now','localtime','-5 minutes')) AS fresh,
                (SELECT COUNT(*) FROM request_activity ra JOIN record r ON r.id = ra.record_id
                  WHERE r.failed_code = 'recovered_orphan'
                    AND ra.activities LIKE '%孤儿记录回收%') AS activities`,
        );
        const row = summary[0] ?? {};
        expect(Number(row.still_orphan), "超阈值的孤儿不该有残留").toBe(0);
        expect(Number(row.recovered)).toBeGreaterThanOrEqual(ORPHAN_COUNT);
        expect(Number(row.fresh), "未超阈值的新请求不能被误判为孤儿").toBe(FRESH_COUNT);
        // 活动日志也必须一起批量化落库：修 P2-27 的第二堵墙时最容易「为了绕开 subrequest 配额
        // 把日志写丢」，所以按条数硬卡，而不是只看 recovered 数字。
        expect(Number(row.activities), "每条被回收的记录都要有回收活动（批量 UPSERT 不能漏写）")
            .toBeGreaterThanOrEqual(ORPHAN_COUNT);
        baseline = { recovered: Number(row.recovered), activities: Number(row.activities) };

        // 抽样：同一条记录只追加一次回收活动（UPSERT 幂等，不能重复 append）
        const activitySample = await dbHelper.query<any>(
            `SELECT ra.activities FROM request_activity ra
             JOIN record r ON r.id = ra.record_id
             WHERE r.failed_code = 'recovered_orphan' LIMIT 5`,
        );
        expect(activitySample.length).toBeGreaterThan(0);
        for (const row of activitySample) {
            const parsed = JSON.parse(row.activities) as Array<{ message?: string }>;
            const recovery = parsed.filter((a) => a.message === "孤儿记录回收");
            expect(recovery.length, "同一记录不应重复追加回收活动").toBe(1);
        }
    }, 120000);

    // P2-27 已修，幂等用例在 worker 下也打开
    it("重复调用幂等：第二次 recovered=0，记录不会被重复改写", async () => {
        // 顺序有意为之：先 HTTP 再查库。worker 下 CLI 查询之后的 HTTP 请求会被 dev server
        // 连接重连竞态打断（诊断实测与接口无关），把 HTTP 放前面可以完全避开这个测量坑；
        // 快照用上一条用例落下的 baseline，不需要在请求前后各查一次库。
        const response = await requestHelper.post("/record/recover-orphans.json", {}, adminToken);
        expect(response.status).toBe(200);
        expect(response.body.recovered, "已经收尾的记录不能被二次回收").toBe(0);

        const summary = await dbHelper.query<any>(
            `SELECT
                (SELECT COUNT(*) FROM record WHERE failed_code = 'recovered_orphan') AS recovered,
                (SELECT COUNT(*) FROM request_activity
                  WHERE activities LIKE '%孤儿记录回收%') AS activities`,
        );
        const row = summary[0] ?? {};
        // 幂等不只是「计数为 0」：记录不能被二次改写，活动日志也不能翻倍
        expect(Number(row.recovered), "记录不能被二次改写").toBe(baseline.recovered);
        expect(Number(row.activities), "重复调用不得重复追加回收活动").toBe(baseline.activities);
    }, 60000);

    // P2-27 反向守卫：活动写入是 best-effort（失败不回滚已回收记录）。
    // 「为了绕开 subrequest 配额把日志写丢」是本项最大的副作用风险，所以不仅要验「正常时写进去」，
    // 还要验「真写不进去时会怎样」：记录必须照样被回收，且必须留下可发现的 warn 日志。
    // 注入方式用「删表」这种自然失败，不依赖 mock（进程内既不能 mock 服务端，也不该为测试加后门）。
    it("活动批量写失败时：记录仍被回收，并留下 warn 日志（best-effort 语义）", async () => {
        const FAILURE_COUNT = 5;

        await dbHelper.execute("DROP TABLE request_activity");
        await insertProcessingRecords(FAILURE_COUNT, "-3 hours");

        const response = await requestHelper.post("/record/recover-orphans.json", {}, adminToken);
        expect(response.status, "活动写失败不能让回收接口 500").toBe(200);
        expect(response.body.recovered, "记录回收不能因为活动写失败而放弃")
            .toBeGreaterThanOrEqual(FAILURE_COUNT);

        // 记录确实收尾了（表已被删，所以这里只查 record）
        const summary = await dbHelper.query<any>(
            `SELECT
                (SELECT COUNT(*) FROM record
                  WHERE status = 'failed' AND failed_code = 'recovered_orphan' AND end_at IS NOT NULL) AS recovered,
                (SELECT COUNT(*) FROM record
                  WHERE status IN ('init','processing') AND end_at IS NULL
                    AND start_at < datetime('now','localtime','-10 minutes')) AS still_orphan`,
        );
        const row = summary[0] ?? {};
        expect(Number(row.recovered)).toBeGreaterThanOrEqual(baseline.recovered + FAILURE_COUNT);
        expect(Number(row.still_orphan), "活动写失败不影响回收，不能留孤儿").toBe(0);

        // warn 必须留痕（不能是静默 catch）：读 app.log 等一小会儿让 stdout 刷盘
        let hitLog = false;
        for (let i = 0; i < 20 && !hitLog; i += 1) {
            hitLog = readAppLog().includes("孤儿回收活动日志写入失败");
            if (!hitLog) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        expect(hitLog, "活动写入失败必须留下结构化 warn 日志（[recordManager] 孤儿回收活动日志写入失败）")
            .toBe(true);

        // 还原表，避免污染后续用例
        await dbHelper.execute(activityTableDdl);
        const restored = await dbHelper.query<any>("SELECT COUNT(*) AS c FROM request_activity");
        expect(Number(restored[0].c)).toBeGreaterThanOrEqual(0);
    }, 120000);
});
