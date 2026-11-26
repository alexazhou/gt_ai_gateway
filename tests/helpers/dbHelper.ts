import Database from "better-sqlite3";
import { execSync, execFileSync } from "child_process";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import config from "../config";
import { DBAdapter } from "../../src/util/db/dbAdapter";
import { migrate as runMigrations } from "../../src/service/dbMigrationService";
import configService, { ConfigItem } from "../../src/service/configService";
import tenantService from "../../src/service/tenantService";
import { RULE_SOURCE, SYSTEM_PLUGIN_RULES } from "../../src/plugin/systemRules";
import stateStoreService from "../../src/service/stateStoreService";

// Worker mode configuration - use test database
const TEST_DB_NAME = "gt_ai_gateway_test";
const TEST_WRANGLER_CONFIG = "wrangler.test.toml";

// Check if we're in worker mode
const isWorkerMode = process.env.TEST_MODE === "worker";
// Check if we're using MySQL as the DB driver
const isMysql = config.DB_CONFIG.driver === "mysql";

// 共享的 MySQL 连接池（mysql 模式）
let mysqlPool: any = null;
function getMysqlPool(): any {
    if (!mysqlPool) {
        const m = config.DB_CONFIG.mysql;
        const mysql = require("mysql2/promise");
        mysqlPool = mysql.createPool({
            host: m.host,
            port: m.port,
            user: m.user,
            password: m.password,
            database: m.database,
            connectionLimit: 10,
            multipleStatements: true,
            charset: "utf8mb4",
            dateStrings: true,
        });
    }
    return mysqlPool;
}

/**
 * LocalDBAdapter wrapper for test database (better-sqlite3)
 */
class LocalDBAdapter implements DBAdapter {
    constructor(private db: Database.Database) { }

    exec(sql: string): void {
        this.db.exec(sql);
    }

    execTransaction(sqls: string[]): void {
        const run = this.db.transaction(() => {
            for (const sql of sqls) {
                this.db.exec(sql);
            }
        });
        run();
    }

    query<T>(sql: string): T[] {
        return this.db.prepare(sql).all() as T[];
    }

    run(sql: string, ...params: any[]): void {
        this.db.prepare(sql).run(...params);
    }

    close(): void {
        this.db.close();
    }
}

/**
 * MySQL DBAdapter wrapper for test database (mysql2/promise)
 */
class MySQLTestAdapter implements DBAdapter {
    async exec(sql: string): Promise<void> {
        await getMysqlPool().query(sql);
    }

    async query<T>(sql: string): Promise<T[]> {
        const [rows] = await getMysqlPool().query(sql);
        return rows as T[];
    }

    async run(sql: string, ...params: any[]): Promise<void> {
        await getMysqlPool().execute(sql, params);
    }

    async execTransaction(sqls: string[]): Promise<void> {
        const conn = await getMysqlPool().getConnection();
        try {
            await conn.beginTransaction();
            for (const s of sqls) {
                await conn.query(s);
            }
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    }

    async close(): Promise<void> {
        if (mysqlPool) {
            await mysqlPool.end();
            mysqlPool = null;
        }
    }
}

/**
 * WorkerDBAdapter wrapper for test database (wrangler local D1)
 */
class WorkerDBAdapter implements DBAdapter {
    exec(sql: string): void {
        const singleLine = sql.replace(/\n/g, " ");
        runD1Command(["--command", singleLine]);
    }

    query<T>(sql: string): T[] {
        const singleLine = sql.replace(/\n/g, " ");
        const output = runD1Command([
            "--json",
            "--command",
            singleLine,
        ]);
        try {
            const match = output.match(/\[.*\]/s);
            if (match) {
                const parsed = JSON.parse(match[0]);
                if (
                    Array.isArray(parsed) &&
                    parsed.length > 0 &&
                    Array.isArray(parsed[0]?.results)
                ) {
                    return parsed[0].results as T[];
                }
                return parsed as T[];
            }
            return [];
        } catch (e) {
            return [];
        }
    }

    run(sql: string): void {
        this.exec(sql);
    }

    close(): void {
        // No-op for wrangler
    }
}

// State
let localDb: Database.Database | null = null;
let adapter: DBAdapter | null = null;

/**
 * Create the appropriate DBAdapter based on TEST_MODE / DB_DRIVER
 */
function createAdapter(): DBAdapter {
    if (isWorkerMode) {
        console.log("Using WorkerDBAdapter (wrangler local D1)");
        return new WorkerDBAdapter();
    } else if (isMysql) {
        console.log("Using MySQLTestAdapter (mysql2)");
        return new MySQLTestAdapter();
    } else {
        if (!localDb) {
            localDb = new Database(config.DB_CONFIG.path);
        }
        console.log("Using LocalDBAdapter (better-sqlite3)");
        return new LocalDBAdapter(localDb);
    }
}

/** D1 锁冲突的重试次数与退避基数（worker 门专用，见 runD1Command 注释） */
const D1_LOCK_RETRY_ATTEMPTS = 6;
const D1_LOCK_RETRY_BASE_DELAY_MS = 250;

/**
 * worker 门子进程计数（#378）：`runD1Command` 每真正拉起一次 `npx wrangler d1 execute` 就 +1。
 * 用来给「truncate() 期间 0 次子进程」提供**可复跑**的证据（任何 runner 都能读前后差值），
 * 不改变任何行为。
 */
let d1SpawnCount = 0;

/** 读当前累计的 D1 子进程次数（#378 证据用） */
function getD1SpawnCount(): number {
    return d1SpawnCount;
}

/** 重置 D1 子进程计数（#378 证据用） */
function resetD1SpawnCount(): void {
    d1SpawnCount = 0;
}

/** 同步睡一小会儿（worker 门的 helper 是同步 API，不能用 await） */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 是否是「本地 D1 被别的进程短暂锁住」这类瞬时错误 */
function isD1LockError(error: unknown): boolean {
    const text = [
        error instanceof Error ? error.message : String(error),
        String((error as { stderr?: unknown })?.stderr ?? ""),
        String((error as { output?: unknown })?.output ?? ""),
    ].join("\n");
    return text.includes("database is locked") || text.includes("SQLITE_BUSY");
}

/**
 * 执行一条 wrangler D1 命令（worker 模式专用）。
 * 上一个测试文件刚结束时，workerd 可能还占着本地 D1 的写锁，wrangler 会报
 * `SQLITE_BUSY / database is locked`；不重试的话紧接着的建规则会撞 UNIQUE。
 * 只对锁类错误重试（6 次、250ms 递增），其它错误立刻抛。详见 shared/gateway-plugin-t7/report.md
 */
function runD1Command(args: string[]): string {
    for (let attempt = 1; ; attempt += 1) {
        try {
            d1SpawnCount += 1;
            return execFileSync(
                "npx",
                ["wrangler", "d1", "execute", TEST_DB_NAME, "--local", "--config", TEST_WRANGLER_CONFIG, ...args],
                { encoding: "utf-8", stdio: "pipe" },
            );
        } catch (error) {
            if (attempt >= D1_LOCK_RETRY_ATTEMPTS || !isD1LockError(error)) {
                throw error;
            }
            const delay = D1_LOCK_RETRY_BASE_DELAY_MS * attempt;
            console.warn(`[WORKER_SETUP] D1 被锁（第 ${attempt} 次），${delay}ms 后重试`);
            sleepSync(delay);
        }
    }
}

/**
 * Drop 所有 D1 本地表（含 `_migrations`）——worker 模式专用
 * 保留 `_migrations` 会让下一轮迁移被判定「已执行」而跳过，因此必须一起删掉，从零重跑。
 */
async function clearD1LocalDatabase(): Promise<void> {
    console.log("[WORKER_SETUP] Clearing D1 test database via SQL...");

    try {
        const tables = await listBusinessTables(false);

        if (tables.length === 0) {
            console.log("[WORKER_SETUP] No tables to drop");
            return;
        }

        runD1Command(["--command", tables.map((t) => `DROP TABLE IF EXISTS ${t.name};`).join(" ")]);
        console.log(`[WORKER_SETUP] Dropped ${tables.length} tables: ${tables.map((t) => t.name).join(", ")}`);
    } catch (e) {
        console.error("[WORKER_SETUP] Failed to clear D1 test database:", e);
    }
}

/**
 * Remove local database file - node mode only
 */
function removeDatabaseFile(): void {
    if (existsSync(config.DB_CONFIG.path)) {
        console.log("Removing test database file:", config.DB_CONFIG.path);
        unlinkSync(config.DB_CONFIG.path);
    }
}

/**
 * Run migrations for D1 using command line (worker mode only)
 */
function runD1Migrations(): void {
    console.log("[GLOBAL_SETUP] Running migrations for D1...");
    try {
        execSync(
            `npx tsx script/db.ts migrate --env worker-local --db-name ${TEST_DB_NAME} --config ${TEST_WRANGLER_CONFIG}`,
            {
                stdio: "inherit",
            },
        );
    } catch (e) {
        console.error("[GLOBAL_SETUP] Failed to run migrations:", e);
    }
}

/**
 * 列出 MySQL 库内全部表（含 `_migrations` 与下划线开头的表）。
 * `DATABASE()` 里看不到系统库表，故这里不做前缀过滤——重置 schema 需要「一张不剩」。
 */
async function listAllMysqlTables(): Promise<{ name: string }[]> {
    const [rows] = await getMysqlPool().query(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
    );
    return (rows as any[]).map((r: any) => ({ name: r.name }));
}

/**
 * 列出业务表名（按驱动分支）：mysql 用 information_schema，sqlite/d1 用 sqlite_master
 * 返回 { name }[]，供 cleanup / truncate / clearD1* 使用。
 *
 * `excludeMigrations`：是否排除 `_migrations`
 * - 批量清数据（truncate）→ true，保留迁移记录
 * - 重置 schema（cleanup / clearD1LocalDatabase）→ false，连迁移记录一起删，下一轮重跑迁移
 *
 * 注意：mysql 分支下划线开头的表（含 `_migrations`）统一不算业务表，故该参数在 mysql 下无额外作用；
 * 需要连 `_migrations` 一起删的场景请直接用 `listAllMysqlTables()`。
 */
async function listBusinessTables(excludeMigrations: boolean): Promise<{ name: string }[]> {
    if (isMysql) {
        const tables = await listAllMysqlTables();
        return tables.filter((t) => !t.name.startsWith("_"));
    }

    const sqliteListSql = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`;
    let rows: { name: string }[];

    if (isWorkerMode) {
        const output = runD1Command(["--json", "--command", sqliteListSql]);
        const match = output.match(/\[.*\]/s);
        if (!match) return [];
        const parsed = JSON.parse(match[0]);
        rows = (Array.isArray(parsed) && Array.isArray(parsed[0]?.results) ? parsed[0].results : []) as {
            name: string;
        }[];
    } else {
        rows = localDb!.prepare(sqliteListSql).all() as { name: string }[];
    }

    const names = excludeMigrations ? rows.filter((r) => r.name !== "_migrations") : rows;
    return names.map((r) => ({ name: r.name }));
}

/**
 * Unified database initialization method - handles both node and worker modes
 * This is the primary entry point for database setup in tests
 */
async function initDatabase(): Promise<void> {
    if (isWorkerMode) {
        console.log("[INIT_DATABASE] Worker mode: D1 database managed by wrangler");
        await clearD1LocalDatabase();
        runD1Migrations();
    } else if (isMysql) {
        // MySQL：无文件可删，先 DROP 全部表（含 _migrations），保证每次从空库重新迁移
        console.log("[INIT_DATABASE] MySQL mode: clearing test database schema");
        await dropAllMysqlTables();
        console.log("Initializing test database...");
        await init();
        console.log("[INIT_DATABASE] Database initialized");
    } else {
        removeDatabaseFile();
        console.log("[INIT_DATABASE] Database file deleted");

        console.log("Initializing test database...");
        await init();
        console.log("[INIT_DATABASE] Database initialized");
    }
}

/**
 * DROP 掉 MySQL 库中所有表（含 `_migrations`），用于每次测试前重置 schema
 */
async function dropAllMysqlTables(): Promise<void> {
    const pool = getMysqlPool();
    // 关闭外键检查，避免因表间外键（如 recharge_records -> user）导致 DROP 顺序报错
    await pool.query("SET FOREIGN_KEY_CHECKS = 0");
    try {
        // 必须连 _migrations 一起删：否则下一轮迁移会被判定「已执行」而跳过，表不存在导致全量测试失败
        for (const t of await listAllMysqlTables()) {
            await pool.query(`DROP TABLE IF EXISTS ${t.name}`);
        }
    } finally {
        await pool.query("SET FOREIGN_KEY_CHECKS = 1");
    }
}

/**
 * Unified database cleanup method - handles both node and worker modes
 * This is the primary entry point for database cleanup in tests
 */
async function clearDatabase(shouldCleanup: boolean = true): Promise<void> {
    if (!shouldCleanup) {
        return;
    }

    if (isWorkerMode) {
        console.log("[CLEAR_DATABASE] Worker mode: Cleaning up D1 local database...");
        await clearD1LocalDatabase();
        console.log("[CLEAR_DATABASE] D1 local database cleaned up");
    } else {
        console.log("Cleaning up test database...");
        await cleanup();
        removeDatabaseFile();
        console.log("[CLEAR_DATABASE] Database cleaned up and file deleted");
    }
}

/**
 * Initialize test database with migrations
 */
async function init(): Promise<void> {
    if (adapter) {
        console.log("Database already initialized");
        return;
    }

    console.log(
        isWorkerMode
            ? "Initializing worker test database (wrangler local D1)..."
            : `Initializing test database: ${config.DB_CONFIG.path}`,
    );

    adapter = createAdapter();

    // Run migrations using the shared migration logic
    await runMigrations(adapter, isWorkerMode ? "worker-local" : "test", {
        dbName: TEST_DB_NAME,
        configPath: TEST_WRANGLER_CONFIG,
    });

    console.log("Test database initialized successfully");
}

/**
 * Cleanup database - remove all data
 */
async function cleanup(): Promise<void> {
    if (!adapter) {
        console.log("Database not initialized, nothing to cleanup");
        return;
    }

    console.log("Cleaning up test database...");

    const tables = await listBusinessTables(false);

    for (const table of tables) {
        try {
            await adapter.exec(`DROP TABLE IF EXISTS ${table.name}`);
        } catch (e) {
            console.error(`Failed to drop table ${table.name}:`, e);
        }
    }

    console.log("Database cleaned up");
}

/**
 * 删除 rule 表里全部记录后，重新创建这三条系统规则（`migrate_0035` 在真库上预置的那三条）。
 * 启用状态要读后台当前的配置开关，不能写死。
 * 不重建的话，三个插件就不会再运行；把 truncate() 里的本函数删掉，全量用例会红 23 例（8 个文件）。
 * 详见 shared/gateway-plugin-t7/report.md §五
 */
async function seedSystemRules(): Promise<void> {
    const values: string[] = [];
    for (const definition of SYSTEM_PLUGIN_RULES) {
        // 不走 configService.getConfig()：它底层是 ORM，而 API 测试进程里 ORM 没连；
        // 这里用裸 SQL 读当前值 + configService 导出的同一份默认值。
        const rows = await query<{ value: string }>(
            `SELECT value FROM config WHERE name = '${definition.configKey}'`,
        );
        const enabled = new ConfigItem(rows[0]?.value, configService.getConfigDefault(definition.configKey)).getBoolean() ? 1 : 0;
        const scope = JSON.stringify({ type: "const", values: [true] });
        const config = JSON.stringify({ plugin: definition.plugin, pluginConfig: definition.pluginConfig });
        values.push(
            `('plugin', '${definition.name}', '${scope}', '${config}', ${enabled}, `
            + `(SELECT id FROM tenant WHERE name = 'main'), 1, ${definition.priority}, `
            + `'${RULE_SOURCE.SYSTEM}', '${definition.bizId}', '${definition.note}')`,
        );
    }
    // 先删再插：清表失败时表里可能还有旧行，重复插入会撞 UNIQUE。
    await execute("DELETE FROM rule WHERE source = 'system'");
    await execute(
        "INSERT INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id, note) "
        + `VALUES ${values.join(", ")}`,
    );
}


/**
 * 清表后重建 main 主租户（多租户隔离）：truncate 会清掉 tenant 表，不重建则
 * tenantService.getMainTenantId() 失败，所有租户逻辑在测试里不可用。
 */
async function seedMainTenant(): Promise<void> {
    const isMysqlDriver = config.DB_CONFIG.driver === "mysql";
    const sql = isMysqlDriver
        ? "INSERT INTO tenant (id, name, description) VALUES (1, 'main', '主租户（自动生成）') ON DUPLICATE KEY UPDATE name='main'"
        : "INSERT OR REPLACE INTO tenant (id, name, description) VALUES (1, 'main', '主租户（自动生成）')";
    try {
        if (isWorkerMode) {
            runD1Command(["--command", sql]);
        } else if (isMysqlDriver) {
            // await 落库后再清缓存，避免 getMainTenantId() 撞上 INSERT 未提交（"Main tenant not found" 偶发）
            await getMysqlPool().query(sql);
        } else {
            adapter!.exec(sql);
        }
    } catch (err: unknown) {
        console.error("Failed to seed main tenant:", err);
    }
    tenantService.clearMainTenantCache();
}

/**
 * 清除测试服务端进程的缓存（带重试处理 worker 本地重载的连接瞬断）。
 *
 * **非 2xx 必须抛错**（#378 验收 ⑩）：以前只 `fetch` 不看状态码，端点不存在（404）时会被静默吞掉，
 * 表现为「用例之间缓存不清、个别用例莫名红/绿」，排查成本极高。现在把状态码当错误抛出，
 * 只对**连接类**失败重试（404/500 这类立刻抛，重试没有意义）。
 */
async function clearServerCache(): Promise<void> {
    const url = `http://127.0.0.1:${config.SERVER_CONFIG.port}/test/cache/clear`;
    let lastError: unknown;

    for (let i = 0; i < 3; i++) {
        try {
            const response = await fetch(url, { method: "DELETE" });
            if (!response.ok) {
                throw Object.assign(
                    new Error(
                        `DELETE /test/cache/clear 返回 ${response.status}：服务端缓存未清理`
                        + `（测试入口没挂上测试路由？检查 TEST_MODE 与 LOCAL_EXTEND_MODULE）`,
                    ),
                    { fatal: true },
                );
            }
            return;
        } catch (e) {
            lastError = e;
            if ((e as { fatal?: boolean })?.fatal) {
                throw e;
            }
            if (i < 2) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** POST /test/reset 的 HTTP 重试次数与退避基数（只重试连接类/5xx，4xx 是语句本身的错不重试） */
const TEST_RESET_HTTP_ATTEMPTS = 3;
const TEST_RESET_HTTP_RETRY_BASE_DELAY_MS = 100;

/**
 * worker 模式下调用测试端点的 `POST /test/reset`：一次调用完成
 * 「清业务表 + 重建 main 租户 + 重建系统规则 + 清服务端缓存」，全程 0 次子进程（#378）。
 *
 * 语句构造放在端点里而非这里，是因为「开关现值必须在清表之后读」——放测试侧拼语句就得多一轮
 * HTTP（先清表 → 再读 → 再写），端点内做可以一次调用内按序完成，且失败时能直接报出
 * 「阶段 + 第几条 + 原文」。
 */
async function resetViaTestEndpoint(): Promise<void> {
    const url = `http://127.0.0.1:${config.SERVER_CONFIG.port}/test/reset`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= TEST_RESET_HTTP_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const text = await response.text();
            const parsed = (text ? JSON.parse(text) : {}) as {
                error?: string;
                phase?: string;
                failedIndex?: number | null;
                failedStatement?: string | null;
            };

            if (!response.ok) {
                const located = parsed.failedIndex === null || parsed.failedIndex === undefined
                    ? ""
                    : `；失败语句[${parsed.failedIndex}]: ${parsed.failedStatement}`;
                const failure = new Error(
                    `POST /test/reset 失败 (${response.status}, 阶段 ${parsed.phase ?? "?"}): `
                    + `${parsed.error ?? response.statusText}${located}`,
                );
                // 4xx = 语句本身的问题，重试无意义
                if (response.status >= 400 && response.status < 500) {
                    throw Object.assign(failure, { fatal: true });
                }
                throw failure;
            }

            return;
        } catch (error) {
            lastError = error;
            if ((error as { fatal?: boolean })?.fatal) break;
            if (attempt < TEST_RESET_HTTP_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, TEST_RESET_HTTP_RETRY_BASE_DELAY_MS * attempt));
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Truncate tables - remove all data but keep structure
 */
async function truncate(): Promise<void> {
    // Auto-connect if not initialized
    if (!adapter) {
        adapter = createAdapter();
    }

    // 限流桶 / 上游冷却 / 版本检查缓存都收口在 StateStore 里：清表时一并重置，
    // 否则用例之间的额度与冷却状态会互相污染（服务端进程那一份由 clearServerCache() 走
    // DELETE /test/cache/clear 重置）。
    stateStoreService.reset();

    if (isWorkerMode) {
        // worker 模式：一次 POST /test/reset 完成清表+播种（0 次子进程，见 #378）
        await resetViaTestEndpoint();

        // Clear in-memory config cache so tests don't leak state across runs
        // （测试进程自己那份；服务端那份由端点里的 clearServerCaches() 清）
        configService.clearCache();
        return;
    }

    console.log("Truncating tables...");

    const tables = await listBusinessTables(true);

    if (isMysql) {
        // MySQL 清表：关闭外键检查后 DELETE，避免外键约束导致顺序问题
        await getMysqlPool().query("SET FOREIGN_KEY_CHECKS = 0");
        for (const table of tables) {
            try {
                await getMysqlPool().query(`DELETE FROM ${table.name}`);
            } catch (e) {
                console.error(`Failed to truncate table ${table.name}:`, e);
            }
        }
        await getMysqlPool().query("SET FOREIGN_KEY_CHECKS = 1");
    } else {
        for (const table of tables) {
            try {
                adapter.exec(`DELETE FROM ${table.name}`);
            } catch (e) {
                console.error(`Failed to truncate table ${table.name}:`, e);
            }
        }
    }

    // 多租户隔离：重建 main 主租户
    await seedMainTenant();

    // Clear config cache to ensure test isolation
    configService.clearCache();

    // 系统规则是运行期真源，清表后必须重建（见 seedSystemRules 注释）
    await seedSystemRules();

    // Also clear the server process's config cache
    await clearServerCache();

    console.log("Tables truncated");
}

/**
 * Execute raw SQL query
 */
async function query<T>(sql: string, params: any[] = []): Promise<T[]> {
    if (!adapter) {
        throw new Error("Database not initialized");
    }

    try {
        if (isWorkerMode) {
            return adapter.query<T>(sql) as unknown as T[];
        } else if (isMysql) {
            const [rows] = await getMysqlPool().execute(sql, params);
            return rows as T[];
        } else {
            return localDb!.prepare(sql).all(...params) as T[];
        }
    } catch (e) {
        console.error("Query failed:", sql, params, e);
        throw e;
    }
}

/**
 * Execute raw SQL statement (insert, update, delete)
 */
async function execute(sql: string, params: any[] = []): Promise<unknown> {
    if (!adapter) {
        throw new Error("Database not initialized");
    }

    try {
        if (isWorkerMode) {
            adapter.run(sql);
        } else if (isMysql) {
            const [result] = await getMysqlPool().execute(sql, params);
            return result;
        } else {
            return localDb!.prepare(sql).run(...params);
        }
    } catch (e) {
        console.error("Execute failed:", sql, params, e);
        throw e;
    }
}

/**
 * Get database instance (only works for LocalDBAdapter)
 */
function getDB(): Database.Database {
    if (isWorkerMode || isMysql) {
        throw new Error("getDB not supported in worker/mysql mode");
    }

    if (!localDb) {
        throw new Error("Database not initialized");
    }
    return localDb;
}

/**
 * Get database adapter instance
 */
function getAdapter(): DBAdapter {
    if (!adapter) {
        throw new Error("Database not initialized");
    }
    return adapter;
}

/**
 * Close database connection
 */
async function close(): Promise<void> {
    if (adapter) {
        await adapter.close();
        adapter = null;
        console.log("Database connection closed");
    }

    if (localDb) {
        localDb.close();
        localDb = null;
    }
}

export {
    getD1SpawnCount,
    resetD1SpawnCount,
};

export default {
    initDatabase,   // Unified database initialization
    clearDatabase,  // Unified database cleanup
    init,           // Connection initialization
    cleanup,        // DROP TABLE cleanup
    truncate,       // DELETE cleanup
    query,
    execute,
    seedSystemRules,
    getD1SpawnCount,
    resetD1SpawnCount,
    getAdapter,
    close,
};
