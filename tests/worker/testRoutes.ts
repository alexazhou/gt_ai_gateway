import type { Context } from "hono";
import configService from "../../src/service/configService";
import ruleService from "../../src/service/ruleService";
import tenantService from "../../src/service/tenantService";
import stateStoreService from "../../src/service/stateStoreService";
import ormService from "../../src/service/ormService";
import { ensureSystemRules } from "../../src/plugin/systemRulesSync";
import type { App } from "../../src/app";

/** 哨兵表名：不存在 ⇒ 用作「这批语句是否成功」的探针（失败即整批回滚，不留痕） */
const SENTINEL_TABLE = "__test_sql_sentinel__";

/** 探针上限：语句太多时不做定位（避免一次请求打出上百次 batch） */
const PROBE_LIMIT = 100;

/** 业务表清单（排除 sqlite 内部表与迁移记录） */
const SQLITE_LIST_TABLES_SQL = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`;

/**
 * 业务表名进程内缓存（#378）：一次 run 内表结构不变，故只查一次。
 * 失效条件：① `POST /test/reset` 的清理阶段报 `no such table`（有用例会 drop 表做反向守卫）⇒
 * 自动清缓存重读一次；② worker 进程重启（缓存随进程消失）。
 */
let businessTableNames: string[] | null = null;

/** 双保险门禁之一：即使走到了测试入口，也要 TEST_MODE 存在才响应，否则当作不存在 */
function isTestMode(c: Context): boolean {
    const env = c.env as { TEST_MODE?: string } | undefined;
    return Boolean(process.env.TEST_MODE || env?.TEST_MODE);
}

/**
 * 清服务端进程内缓存。抽出来是为了让 `DELETE /test/cache/clear` 与 `POST /test/reset`
 * 共用同一份实现（#378：清库与清缓存并成一次调用，省掉一次 HTTP 往返）。
 */
function clearServerCaches(): void {
    configService.clearCache();
    ruleService.invalidateCache();
    // 测试清表后 main 租户 id 可能变化（SQLite AUTOINCREMENT 不重置），须清 tenantService 缓存
    tenantService.clearMainTenantCache();
    // 限流桶 / 上游冷却 / 版本检查缓存都在 StateStore 里，清表时必须一起重置，
    // 否则同一个测试进程里前一个用例的额度或冷却会漏到下一个用例。
    stateStoreService.reset();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 前缀批是否「真的有语句失败」：把 statements 加上末尾哨兵 `SELECT ... FROM __test_sql_sentinel__` 一起执行。
 * - 前缀全好 ⇒ 只有哨兵那句报 `no such table: __test_sql_sentinel__` ⇒ 返回 false；
 * - 前缀里有坏句 ⇒ 报的是坏句自己的错（哨兵还没轮到）⇒ 返回 true。
 */
async function prefixHasFailure(db: D1Database, statements: string[]): Promise<boolean> {
    try {
        await db.batch([
            ...statements.map((sql) => db.prepare(sql)),
            db.prepare(`SELECT * FROM ${SENTINEL_TABLE}`),
        ]);
        return false;
    } catch (error) {
        return !errorMessage(error).includes(SENTINEL_TABLE);
    }
}

/**
 * D1 `batch` 失败时不报告是哪条语句失败，只能探。
 *
 * 不能逐条「单句 + 哨兵」隔离探测：**语句之间可能互相依赖**（如 `CREATE TABLE t` 后紧跟
 * `INSERT INTO t`），单句探 INSERT 会因表不存在而报错，把失败下标指到 INSERT 上（实测：
 * `[CREATE t, INSERT t, <坏句>]` 会被误报成 1，实际是 2）。
 *
 * 因此探「**前缀**」：`statements[0..i]` 全好 ⇔ 只报哨兵错。「前缀是否失败」对 i 单调
 * （i 越过坏句之后恒为 true），所以用二分找第一个失败的前缀，下标即失败语句下标，
 * 批次数量 O(log n)，且每次探测都随整批回滚、不留痕。
 */
async function locateFailingStatement(db: D1Database, statements: string[]): Promise<number | null> {
    if (statements.length > PROBE_LIMIT) {
        return null;
    }

    let lo = 0;
    let hi = statements.length - 1;
    // 只有走到这里才说明整批已经失败过，理论上 hi 一定是失败前缀；兜一下防御
    if (!(await prefixHasFailure(db, statements.slice(0, hi + 1)))) {
        return null;
    }

    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await prefixHasFailure(db, statements.slice(0, mid + 1))) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }

    return lo;
}

/** 带失败定位信息的批执行错误：把「第几条 + 原文」挂到错误上，便于端点回给测试侧 */
type BatchFailure = Error & { failedIndex?: number | null; failedStatement?: string | null };

async function runBatch(db: D1Database, statements: string[]): Promise<void> {
    try {
        await db.batch(statements.map((sql) => db.prepare(sql)));
    } catch (error) {
        const failedIndex = await locateFailingStatement(db, statements);
        const failure = new Error(errorMessage(error)) as BatchFailure;
        failure.failedIndex = failedIndex;
        failure.failedStatement = failedIndex === null ? null : statements[failedIndex];
        throw failure;
    }
}

/** 读业务表清单（进程内缓存；`refresh` 用于缓存过期后重读） */
async function readBusinessTableNames(db: D1Database, refresh = false): Promise<string[]> {
    if (!refresh && businessTableNames) {
        return businessTableNames;
    }
    const result = await db.prepare(SQLITE_LIST_TABLES_SQL).all<{ name: string }>();
    const names = ((result.results ?? []) as { name: string }[])
        .map((row) => row.name)
        .filter((name) => name !== "_migrations");
    businessTableNames = names;
    return names;
}

/**
 * 测试专用路由：只由 `tests/worker/testEntry.ts` 挂载，生产入口（`src/index.ts`）不含本文件。
 */
export function registerTestRoutes(app: App): void {
    app.delete("/test/cache/clear", async (c) => {
        if (!isTestMode(c)) {
            return c.notFound();
        }
        clearServerCaches();
        return c.json({ success: true });
    });

    /**
     * 生成/纠偏系统规则（#382）：直接调用生产 `ensureSystemRules()`。
     * 目的是让「清表后重建」「漂移纠正」「幂等」这些用例走与生产同一条实现，
     * 而不是在测试里再写一份 SQL。生产入口不含本文件，所以不是产品后门。
     */
    app.post("/test/ensure-system-rules", async (c) => {
        if (!isTestMode(c)) {
            return c.notFound();
        }
        const ensured = await ensureSystemRules();
        return c.json(ensured);
    });

    /**
     * 复位 worker 侧「每 isolate 只 ensure 一次」的标记（#382）。
     *
     * 存在的理由：worker 的 ensure 挂在 `connectWorker` 上，正常用例里第一个请求就把它跑完了，
     * 于是「把 ensure 从请求链路摘掉」没有任何判据（实测全套门仍全绿）。复位后下一个请求会重新
     * 走那条接线，`tests/api/rule/systemRulesEnsure.test.ts` 里据此断言「删掉的行由新请求补齐」。
     * 生产入口不含本文件，所以不是产品后门。
     */
    app.post("/test/system-rules-ensure-reset", async (c) => {
        if (!isTestMode(c)) {
            return c.notFound();
        }
        ormService.resetSystemRulesEnsureStateForTest();
        return c.json({ success: true });
    });

    /**
     * 一次调用执行多条 SQL（清库 + 播种要跑十几条，逐个 HTTP 往返比子进程还慢）。
     * 失败时 400 并给出失败语句下标与原文，便于定位。
     *
     * `clearCache: true` 额外把服务端缓存清掉；`results[].rows` 带回 SELECT 的行。
     */
    app.post("/test/sql", async (c) => {
        if (!isTestMode(c)) {
            return c.notFound();
        }

        let payload: unknown;
        try {
            payload = await c.req.json();
        } catch {
            return c.json({ error: "invalid JSON body" }, 400);
        }

        const statements = (payload as { statements?: unknown } | null)?.statements;
        if (
            !Array.isArray(statements)
            || statements.length === 0
            || statements.some((sql) => typeof sql !== "string" || sql.trim() === "")
        ) {
            return c.json({ error: "statements must be a non-empty array of non-empty strings" }, 400);
        }

        const db = c.env.DB;
        const sqlList = statements as string[];
        // 可选：清库后把服务端缓存一并清掉
        const clearCache = Boolean((payload as { clearCache?: unknown } | null)?.clearCache);

        try {
            const results = await db.batch(sqlList.map((sql) => db.prepare(sql)));
            if (clearCache) {
                clearServerCaches();
            }
            return c.json({
                results: results.map((result) => ({
                    success: result.success,
                    meta: result.meta,
                    // SELECT 的行要带回来：#378 的 truncate 要靠它读表清单与配置开关现值
                    rows: (result as { results?: unknown[] }).results ?? [],
                })),
            });
        } catch (error) {
            const failedIndex = await locateFailingStatement(db, sqlList);
            return c.json({
                error: errorMessage(error),
                failedIndex,
                failedStatement: failedIndex === null ? null : sqlList[failedIndex],
            }, 400);
        }
    });

    /**
     * #378：worker 模式下 `dbHelper.truncate()` 的唯一一次调用。
     * 顺序与改造前逐条等价：
     *   ① 读表清单（进程内缓存）→ DELETE 每张业务表；
     *   ② 重建 main 主租户（`INSERT OR REPLACE tenant(1,'main',…)`）；
     *   ③ `DELETE FROM rule WHERE source='system'`；
     *   ④ **清表之后**读 4 个开关现值（回落默认值）→ INSERT 4 条系统规则；
     *   ⑤ 清服务端缓存（原来那次单独的 `DELETE /test/cache/clear`）。
     * 失败回 400 + 阶段 + 失败语句下标/原文（失败可见性不退化）。
     */
    app.post("/test/reset", async (c) => {
        if (!isTestMode(c)) {
            return c.notFound();
        }

        const db = c.env.DB;
        let phase = "read-tables";

        try {
            let tables = await readBusinessTableNames(db);
            phase = "clear-tables";
            const clearStatements = () => [
                ...tables.map((name) => `DELETE FROM ${name}`),
                "INSERT OR REPLACE INTO tenant (id, name, description) VALUES (1, 'main', '主租户（自动生成）')",
                "DELETE FROM rule WHERE source = 'system'",
            ];

            try {
                await runBatch(db, clearStatements());
            } catch (error) {
                // 表清单过期（有用例会 drop 表做反向守卫）⇒ 重读一次再试
                if (!/no such table/i.test(errorMessage(error))) {
                    throw error;
                }
                tables = await readBusinessTableNames(db, true);
                await runBatch(db, clearStatements());
            }

            // 系统规则改由生产 ensureSystemRules() 生成（#382）：测试与生产走同一条路径，
            // 不再在这里复制一份 INSERT。它会读 config 当前值（刚清空 ⇒ 回落默认值）作 enabled 初值。
            phase = "ensure-system-rules";
            const ensured = await ensureSystemRules();

            phase = "clear-cache";
            clearServerCaches();

            return c.json({ success: true, tables: tables.length, ensured });
        } catch (error) {
            const failure = error as BatchFailure;
            return c.json({
                error: errorMessage(error),
                phase,
                failedIndex: failure?.failedIndex ?? null,
                failedStatement: failure?.failedStatement ?? null,
            }, 400);
        }
    });
}
