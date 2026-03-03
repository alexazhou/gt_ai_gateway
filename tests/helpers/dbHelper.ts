import Database from "better-sqlite3";
import { execSync } from "child_process";
import { join } from "path";
import { existsSync, unlinkSync, rmSync } from "fs";
import config from "../config";
import {
    migrate as runMigrations,
    DBAdapter,
} from "../../script/db";

// Worker mode configuration - use test database
const TEST_DB_NAME = "serverless_ai_gateway_test";
const TEST_WRANGLER_CONFIG = "wrangler.test.toml";
const WRANGLER_D1_DIR = join(process.cwd(), ".wrangler", "state", "v3", "d1");

// Check if we're in worker mode
const isWorkerMode = process.env.TEST_MODE === "worker";

/**
 * LocalDBAdapter wrapper for test database (better-sqlite3)
 */
class LocalDBAdapter implements DBAdapter {
    constructor(private db: Database.Database) {}

    exec(sql: string): void {
        this.db.exec(sql);
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
 * WorkerDBAdapter wrapper for test database (wrangler local D1)
 */
class WorkerDBAdapter implements DBAdapter {
    private dbId = "serverless_ai_gateway";

    private runWrangler(args: string[]): string {
        const cmd = `npx wrangler d1 execute ${this.dbId} --local ${args.join(" ")}`;
        console.log(`> ${cmd}`);
        try {
            const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
            return output;
        } catch (e: any) {
            console.error("Wrangler command failed:", e.message);
            if (e.stdout) console.error("stdout:", e.stdout);
            if (e.stderr) console.error("stderr:", e.stderr);
            throw e;
        }
    }

    exec(sql: string): void {
        const singleLine = sql.replace(/\n/g, " ");
        this.runWrangler([`--command="${singleLine.replace(/"/g, '\\"')}"`]);
    }

    query<T>(sql: string): T[] {
        const output = this.runWrangler([
            `--json --command="${sql.replace(/"/g, '\\"')}"`,
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
 * Create the appropriate DBAdapter based on TEST_MODE
 */
function createAdapter(): DBAdapter {
    if (isWorkerMode) {
        console.log("Using WorkerDBAdapter (wrangler local D1)");
        return new WorkerDBAdapter();
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
    const cmd = `npx wrangler d1 execute ${TEST_DB_NAME} --local --config ${TEST_WRANGLER_CONFIG} ${args.join(" ")}`;
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
}

/**
 * Clear D1 local database file - worker mode only
 */
function clearD1LocalDatabase(): void {
    console.log("[WORKER_SETUP] Clearing D1 test database...");

    try {
        const dbDir = join(WRANGLER_D1_DIR, TEST_DB_NAME);
        if (existsSync(dbDir)) {
            rmSync(dbDir, { recursive: true, force: true });
            console.log("[WORKER_SETUP] D1 test database deleted");
        } else {
            console.log("[WORKER_SETUP] D1 test database not found, skipping");
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
            "--command=\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'\"",
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

            for (const table of tables) {
                runD1Command([`--command=\"DELETE FROM ${table.name}\"`]);
            }

            console.log(`[WORKER_SETUP] Cleared ${tables.length} tables`);
        }
    } catch (e) {
        console.error("[WORKER_SETUP] Failed to clear D1 tables:", e);
    }
}

/**
 * Setup admin user in worker mode (for D1 direct operations)
 */
function setupAdminUser(): void {
    console.log("[WORKER_SETUP] Setting up admin user...");
    const now = new Date().toISOString();
    try {
        runD1Command([
            `--command=\"INSERT INTO user (name, token, type, created_at, updated_at) VALUES ('Admin User', 'admin-token-123', 'admin', '${now}', '${now}')\"`,
        ]);
        console.log("[WORKER_SETUP] Admin user created");
    } catch (e) {
        console.log("[WORKER_SETUP] Admin user might already exist:", (e as any).message || e);
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
 * Global setup for test database - handles both node and worker modes
 */
async function globalSetup(): Promise<void> {
    console.log("[GLOBAL_SETUP] Test mode:", config.TEST_MODE);

    if (isWorkerMode) {
        console.log("[GLOBAL_SETUP] Worker mode: D1 database managed by wrangler");
        clearD1LocalDatabase();
        runD1Migrations();
    } else {
        removeDatabaseFile();
        console.log("[GLOBAL_SETUP] Database file deleted");

        console.log("Initializing test database...");
        await init();
        console.log("[GLOBAL_SETUP] Database initialized");
    }
}

/**
 * Global teardown for test database - handles both node and worker modes
 */
async function globalTeardown(cleanup: boolean = true): Promise<void> {
    if (!cleanup) {
        return;
    }

    if (isWorkerMode) {
        console.log("[GLOBAL_TEARDOWN] Worker mode: Cleaning up D1 local database...");
        clearD1LocalDatabase();
        console.log("[GLOBAL_TEARDOWN] D1 local database cleaned up");
    } else {
        console.log("Cleaning up test database...");
        await cleanup();
        removeDatabaseFile();
        console.log("[GLOBAL_TEARDOWN] Database cleaned up and file deleted");
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
    await runMigrations(adapter, isWorkerMode ? "worker-local" : "test");

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

    const tables = adapter.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'",
    );

    for (const table of tables) {
        try {
            adapter.exec(`DROP TABLE IF EXISTS ${table.name}`);
        } catch (e) {
            console.error(`Failed to drop table ${table.name}:`, e);
        }
    }

    console.log("Database cleaned up");
}

/**
 * Truncate tables - remove all data but keep structure
 */
async function truncate(): Promise<void> {
    if (isWorkerMode) {
        // In worker mode, clear D1 tables by calling helper function
        clearD1Tables();
        setupAdminUser();
        return;
    }

    // Auto-connect if not initialized
    if (!adapter) {
        adapter = createAdapter();
    }

    console.log("Truncating tables...");

    const tables = adapter.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'",
    );

    for (const table of tables) {
        try {
            adapter.exec(`DELETE FROM ${table.name}`);
        } catch (e) {
            console.error(`Failed to truncate table ${table.name}:`, e);
        }
    }

    // Recreate admin user after truncation
    const now = new Date().toISOString();
    try {
        localDb!.prepare(
            "INSERT INTO user (name, token, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run("Admin User", "admin-token-123", "admin", now, now);
        console.log("Admin user recreated");
    } catch (e) {
        console.log("Admin user might already exist:", (e as any).message);
    }

    console.log("Tables truncated");
}

/**
 * Execute raw SQL query
 */
function query<T>(sql: string, params: any[] = []): T[] {
    if (!adapter) {
        throw new Error("Database not initialized");
    }

    try {
        if (isWorkerMode) {
            return adapter.query<T>(sql);
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
function execute(sql: string, params: any[] = []): Database.RunResult | void {
    if (!adapter) {
        throw new Error("Database not initialized");
    }

    try {
        if (isWorkerMode) {
            adapter.run(sql);
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
    if (isWorkerMode) {
        throw new Error("getDB not supported in worker mode");
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
function close(): void {
    if (adapter) {
        adapter.close();
        adapter = null;
        console.log("Database connection closed");
    }

    if (localDb) {
        localDb.close();
        localDb = null;
    }
}

export default {
    globalSetup,
    globalTeardown,
    init,
    cleanup,
    truncate,
    query,
    execute,
    getDB,
    getAdapter,
    close,
    clearD1Tables,
    setupAdminUser,
};