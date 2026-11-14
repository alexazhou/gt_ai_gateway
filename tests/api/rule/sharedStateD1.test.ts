import { beforeEach, describe, expect, it } from "vitest";
import config from "../../config";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import userFixtures from "../../fixtures/userFixtures";

/**
 * P0-2 / P0-3 的「真实 D1」验收用例。
 *
 * 单元用例（`sharedStateStores.node.test.ts`、`rateLimitStore.crossIsolate.node.test.ts`）
 * 证的是 better-sqlite3 上的语义；这里补两件单元层证不了的事：
 *
 * 1. **方言一致性**：`SqlRateLimitStore` / `SqlUpstreamHealthStore` 依赖
 *    标量 `MIN(a,b)` / `MAX(a,b)`、`ON CONFLICT(...) DO UPDATE`、`UPDATE ... RETURNING`。
 *    better-sqlite3 支持不代表 wrangler 本地 D1 也一致，所以同一批 SQL 在两种模式下都跑一遍。
 * 2. **真的走了共享存储**：worker 模式下如果 `resolveStore()` 静默退化回内存实现，
 *    端到端的「第 3 个请求 429」依然会绿（单 isolate 内存也限得对）。所以要直接读库，
 *    断言桶行确实落在 `rate_limit_bucket` 里，并反过来用「预置一个空桶」证明读的是共享库。
 */

const adminToken = userFixtures.ADMIN_TOKEN;
const isWorker = config.TEST_MODE === "worker";

let seq = 0;
function unique(prefix: string): string {
    seq += 1;
    return `${prefix}-${Date.now()}-${seq}`;
}

async function createVendor(): Promise<number> {
    const vendor = await requestHelper.post(
        "/vendor/create.json",
        vendorFixtures.VENDOR_FIXTURES.openai(),
        adminToken,
    );
    expect(vendor.status).toBe(200);
    return vendor.body.id;
}

async function createModel(name: string, vendorId: number) {
    const model = await requestHelper.post(
        "/model/create.json",
        {
            name,
            routing_mode: "single",
            routing_config: {
                upstreams: [{ vendor_id: vendorId, enabled: true }],
                failover: { enabled: false },
            },
        },
        adminToken,
    );
    expect(model.status).toBe(200);
    return model.body;
}

async function createUser() {
    const user = await requestHelper.post(
        "/user/create.json",
        mockHelper.generateUser(),
        adminToken,
    );
    expect(user.status).toBe(200);
    return user.body;
}

function rateLimitRule(modelId: number, rpm: number) {
    return {
        type: "rate_limit",
        name: unique("rl"),
        scope: { type: "model_id", oper: "=", values: [modelId] },
        config: { rpm },
    };
}

/**
 * 执行写 SQL（INSERT / UPDATE / DELETE）。
 * - worker：`dbHelper.query` 走 `wrangler d1 execute --json`，写语句返回空 results，可 await；
 * - node：写语句不返回数据，必须走 `dbHelper.execute`（内部 `stmt.run()`）。
 */
async function runSql(sql: string): Promise<void> {
    if (isWorker) {
        await dbHelper.query(sql);
        return;
    }
    await dbHelper.execute(sql);
}

/**
 * 执行带 `RETURNING` 的写 SQL 并取回结果行。
 * better-sqlite3 需要 `all()` 才拿得到 RETURNING 的行，`run()` 会直接报 "does not return data"。
 */
async function runReturning<T>(sql: string): Promise<T[]> {
    if (isWorker) {
        return await dbHelper.query<T>(sql);
    }
    // node：DBAdapter.query 内部走 better-sqlite3 的 all()，能拿到 RETURNING 的行
    return await dbHelper.getAdapter().query<T>(sql);
}

// 文件级清库 + 重建管理员：两个 describe 都要用（否则单独 -t 过滤跑时会 "Database not initialized"）
beforeEach(async () => {
    // 清库（含 rate_limit_bucket / upstream_health / rule / user），
    // 否则跨用例的桶/冷却行与 user.token 唯一键会互相污染
    await dbHelper.truncate();
    await setupAdminUser();
});

describe("共享状态的 SQL 方言（node=SQLite / worker=真 D1 同批 SQL）", () => {

    it("标量 MIN/MAX 不是聚合函数：逐行返回而非聚合一行", async () => {
        const rows = await dbHelper.query<{ m: number; z: number; neg: number }>(
            "SELECT MIN(3, 5) AS m, MAX(0, -2) AS z, MIN(2, 2) AS neg",
        );
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].m)).toBe(3);
        expect(Number(rows[0].z)).toBe(0);
        expect(Number(rows[0].neg)).toBe(2);
    });

    it("upstream_health 的 ON CONFLICT DO UPDATE 幂等 upsert 生效", async () => {
        const key = `probe-health-${Date.now()}`;

        await runSql(
            `INSERT INTO upstream_health (health_key, failed_at) VALUES ('${key}', 1000)
             ON CONFLICT(health_key) DO UPDATE SET failed_at = excluded.failed_at`,
        );
        // 同键再写一次：必须是更新而不是抛主键冲突
        await runSql(
            `INSERT INTO upstream_health (health_key, failed_at) VALUES ('${key}', 2000)
             ON CONFLICT(health_key) DO UPDATE SET failed_at = excluded.failed_at`,
        );

        const rows = await dbHelper.query<{ health_key: string; failed_at: number }>(
            `SELECT health_key, failed_at FROM upstream_health WHERE health_key = '${key}'`,
        );
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].failed_at)).toBe(2000);

        await runSql(`DELETE FROM upstream_health WHERE health_key = '${key}'`);
    });

    it("UPDATE ... RETURNING 能拿到被改后的行（限流扣减依赖它）", async () => {
        const key = `probe-bucket-${Date.now()}`;
        await runSql(
            `INSERT INTO rate_limit_bucket (bucket_key, tokens, last_ms) VALUES ('${key}', 3, 1000)
             ON CONFLICT(bucket_key) DO NOTHING`,
        );

        const returned = await runReturning<{ tokens: number }>(
            `UPDATE rate_limit_bucket
                SET tokens = MIN(3, tokens + MAX(0, 5000 - last_ms) * 0.001) - 1,
                    last_ms = 5000
              WHERE bucket_key = '${key}'
                AND tokens + MAX(0, 5000 - last_ms) * 0.001 >= 1
              RETURNING tokens`,
        );
        expect(returned).toHaveLength(1);
        // 3 + (5000-1000)*0.001 = 7 → MIN(3, 7) = 3 → 扣 1 = 2
        expect(Number(returned[0].tokens)).toBe(2);

        // 条件不满足时（余量 < 1）不返回任何行，调用方据此判定限流
        const denied = await runReturning<{ tokens: number }>(
            `UPDATE rate_limit_bucket
                SET tokens = MIN(3, tokens) - 1, last_ms = 6000
              WHERE bucket_key = '${key}'
                AND tokens + 0 >= 100
              RETURNING tokens`,
        );
        expect(denied).toHaveLength(0);

        await runSql(`DELETE FROM rate_limit_bucket WHERE bucket_key = '${key}'`);
    });
});

describe.skipIf(!isWorker)("限流共享存储真的生效（worker 真 D1）", () => {
    it("放行时桶行落库：证明走的是 D1 原子扣减，而不是悄悄退回内存实现", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("rl-shared"), vendorId);
        const user = await createUser();

        const rule = await requestHelper.post("/rule/create.json", rateLimitRule(model.id, 5), adminToken);
        expect(rule.status).toBe(200);
        const ruleId = rule.body.id;

        const first = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(first.status).toBe(200);

        const rows = await dbHelper.query<{ bucket_key: string; tokens: number }>(
            `SELECT bucket_key, tokens FROM rate_limit_bucket WHERE bucket_key = 'rule:${ruleId}:rpm'`,
        );
        expect(rows).toHaveLength(1);
        // 桶容量 5，放行一次后剩 4 个（补液可忽略：两次操作间隔 < 1s）
        expect(Number(rows[0].tokens)).toBeGreaterThan(3);
        expect(Number(rows[0].tokens)).toBeLessThanOrEqual(5);

        await runSql(`DELETE FROM rate_limit_bucket WHERE bucket_key = 'rule:${ruleId}:rpm'`);
    });

    it("另一个 isolate 已经把桶扣空时，本 isolate 必须直接 429（读的是共享库）", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("rl-cross"), vendorId);
        const user = await createUser();

        const rule = await requestHelper.post("/rule/create.json", rateLimitRule(model.id, 2), adminToken);
        expect(rule.status).toBe(200);
        const ruleId = rule.body.id;

        // 模拟「另一个 isolate 刚刚用光额度」：直接把桶置空。
        // 注意 rpm 必须取小值（此处 2）：D1 CLI 写种子本身要 1s+，rpm 大时补液会把令牌补回来（50/60000 × 1300ms ≈ 1.1 个），
        // 于是「桶空」被自然补满，用例会假绿/假红。rpm=2 时 30s 才补 1 个，1s 级的延迟不影响判定。
        const nowMs = Date.now();
        await runSql(
            `INSERT INTO rate_limit_bucket (bucket_key, tokens, last_ms)
             VALUES ('rule:${ruleId}:rpm', 0, ${nowMs})
             ON CONFLICT(bucket_key) DO UPDATE SET tokens = 0, last_ms = ${nowMs}`,
        );

        const limited = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );

        // 诊断信息：确认预置的空桶真的落库、且请求后仍存在（避免"种子没写进去"被误判成放行）
        const afterRows = await dbHelper.query<{ bucket_key: string; tokens: number; last_ms: number }>(
            `SELECT bucket_key, tokens, last_ms FROM rate_limit_bucket WHERE bucket_key = 'rule:${ruleId}:rpm'`,
        );
        if (limited.status !== 429) {
            console.log("[DIAG] 429 未触发", JSON.stringify({
                ruleId,
                seededLastMs: nowMs,
                afterRows,
                status: limited.status,
                body: limited.body,
            }));
        }

        // 内存实现会当成本地桶是满的（rpm=50）直接放行；共享存储才会拦下
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

        await runSql(`DELETE FROM rate_limit_bucket WHERE bucket_key = 'rule:${ruleId}:rpm'`);
    });

    it("桶被清掉后能自动初始化（INSERT ON CONFLICT 路径不被卡死）", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("rl-reinit"), vendorId);
        const user = await createUser();

        const rule = await requestHelper.post("/rule/create.json", rateLimitRule(model.id, 3), adminToken);
        const ruleId = rule.body.id;

        await runSql(`DELETE FROM rate_limit_bucket WHERE bucket_key = 'rule:${ruleId}:rpm'`);

        const ok = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(ok.status).toBe(200);

        const rows = await dbHelper.query<{ tokens: number }>(
            `SELECT tokens FROM rate_limit_bucket WHERE bucket_key = 'rule:${ruleId}:rpm'`,
        );
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].tokens)).toBeGreaterThanOrEqual(2);
        expect(Number(rows[0].tokens)).toBeLessThanOrEqual(3);

        await runSql(`DELETE FROM rate_limit_bucket WHERE bucket_key = 'rule:${ruleId}:rpm'`);
    });
});
