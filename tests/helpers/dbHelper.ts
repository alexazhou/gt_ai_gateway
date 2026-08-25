import Database from "better-sqlite3";
import { execSync, execFileSync } from "child_process";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import config from "../config";
import { DBAdapter } from "../../src/util/db/dbAdapter";
import { migrate as runMigrations } from "../../src/service/dbMigrationService";
import configService from "../../src/service/configService";
import tenantService from "../../src/service/tenantService";

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

/**
 * Helper to run wrangler D1 commands (worker mode only)
 */
function runD1Command(args: string[]): string {
    return execFileSync(
        "npx",
        ["wrangler", "d1", "execute", TEST_DB_NAME, "--local", "--config", TEST_WRANGLER_CONFIG, ...args],
        { encoding: "utf-8", stdio: "pipe" },
    );
}

/**
 * Clear D1 local database - worker mode only
 * Uses wrangler d1 execute to DROP all tables (including _migrations),
 * so next run will re-apply all migrations from scratch.
 */
function clearD1LocalDatabase(): void {
    console.log("[WORKER_SETUP] Clearing D1 test database via SQL...");

    try {
        // Query all tables
        const output = runD1Command([
            "--json",
            "--command",
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
        ]);

        const match = output.match(/\[.*\]/s);
        if (match) {
            const parsed = JSON.parse(match[0]);
            const tables =
                Array.isArray(parsed) &&
                    parsed.length > 0 &&
                    Array.isArray(parsed[0]?.results)
                    ? (parsed[0].results as { name: string }[])
                    : [];

            if (tables.length === 0) {
                console.log("[WORKER_SETUP] No tables to drop");
                return;
            }

            const dropStatements = tables.map(t => `DROP TABLE IF EXISTS ${t.name};`).join(" ");
            runD1Command(["--command", dropStatements]);

            console.log(`[WORKER_SETUP] Dropped ${tables.length} tables: ${tables.map(t => t.name).join(", ")}`);
        } else {
            console.log("[WORKER_SETUP] No tables found in database");
        }
    } catch (e) {
        console.error("[WORKER_SETUP] Failed to clear D1 test database:", e);
    }
}

/**
 * Clear D1 database tables (but keep schema) - worker mode only
 */
function clearD1Tables(): void {
    console.log("[WORKER_SETUP] Clearing D1 database tables...");

    try {
        const output = runD1Command([
            "--json",
            "--command",
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'",
        ]);

        const match = output.match(/\[.*\]/s);
        if (match) {
            const parsed = JSON.parse(match[0]);
            const tables =
                Array.isArray(parsed) &&
                    parsed.length > 0 &&
                    Array.isArray(parsed[0]?.results)
                    ? (parsed[0].results as { name: string }[])
                    : [];

            if (tables.length === 0) {
                console.log("[WORKER_SETUP] No tables to clear");
                return;
            }

            // Combine all DELETE statements into a single command for better performance
            const deleteStatements = tables.map(t => `DELETE FROM ${t.name};`).join(" ");
            runD1Command(["--command", deleteStatements]);

            console.log(`[WORKER_SETUP] Cleared ${tables.length} tables`);
        }
    } catch (e) {
        console.error("[WORKER_SETUP] Failed to clear D1 tables:", e);
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
 * 列出业务表名（按驱动分支）：mysql 用 information_schema，sqlite/d1 用 sqlite_master
 * 返回 { name }[]，供 cleanup / truncate 使用
 */
async function listBusinessTables(excludeMigrations: boolean): Promise<{ name: string }[]> {
    if (isMysql) {
        const exclude = excludeMigrations ? " AND table_name != '_migrations'" : "";
        const [rows] = await getMysqlPool().query(
            `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name NOT LIKE '\\_%'${exclude}`,
        );
        return (rows as any[]).map((r: any) => ({ name: r.name }));
    }
    const sqliteListSql = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'${excludeMigrations ? " AND name != '_migrations'" : ""}`;
    if (isWorkerMode) {
        const output = runD1Command(["--json", "--command", sqliteListSql]);
        const match = output.match(/\[.*\]/s);
        if (match) {
            const parsed = JSON.parse(match[0]);
            const rows = Array.isArray(parsed) && Array.isArray(parsed[0]?.results) ? parsed[0].results : [];
            return (rows as { name: string }[]).map((r) => ({ name: r.name }));
        }
        return [];
    }
    return (localDb!.prepare(sqliteListSql).all() as { name: string }[]).map((r) => ({ name: r.name }));
}

/**
 * Unified database initialization method - handles both node and worker modes
 * This is the primary entry point for database setup in tests
 */
async function initDatabase(): Promise<void> {
    if (isWorkerMode) {
        console.log("[INIT_DATABASE] Worker mode: D1 database managed by wrangler");
        clearD1LocalDatabase();
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
 * DROP 掉 MySQL 库中所有业务表（含 _migrations），用于每次测试前重置 schema
 */
async function dropAllMysqlTables(): Promise<void> {
    // 关闭外键检查，避免因表间外键（如 recharge_records -> user）导致 DROP 顺序报错
    await getMysqlPool().query("SET FOREIGN_KEY_CHECKS = 0");
    const [tables] = await getMysqlPool().query(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
    );
    for (const t of tables as any[]) {
        await getMysqlPool().query(`DROP TABLE IF EXISTS ${t.name}`);
    }
    await getMysqlPool().query("SET FOREIGN_KEY_CHECKS = 1");
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
        clearD1LocalDatabase();
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
 * 清除测试服务端进程的缓存（带重试处理 worker 本地重载的连接瞬断）
 */
async function clearServerCache(): Promise<void> {
    for (let i = 0; i < 3; i++) {
        try {
            await fetch(`http://127.0.0.1:${config.SERVER_CONFIG.port}/test/cache/clear`, {
                method: "DELETE",
            });
            break;
        } catch (e) {
            if (i === 2) {
                console.error("Failed to clear server cache:", e);
            } else {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
    }
}

/**
 * Truncate tables - remove all data but keep structure
 */
async function truncate(): Promise<void> {
    // Auto-connect if not initialized
    if (!adapter) {
        adapter = createAdapter();
    }

    if (isWorkerMode) {
        // In worker mode, clear D1 tables only (admin user created via API)
        clearD1Tables();
        await seedMainTenant();

        // Clear in-memory config cache so tests don't leak state across runs
        configService.clearCache();

        await clearServerCache();
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

export default {
    initDatabase,   // Unified database initialization
    clearDatabase,  // Unified database cleanup
    init,           // Connection initialization
    cleanup,        // DROP TABLE cleanup
    truncate,       // DELETE cleanup
    query,
    execute,
    getAdapter,
    close,
};
