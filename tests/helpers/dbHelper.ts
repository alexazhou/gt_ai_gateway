import { readdirSync, readFileSync, existsSync } from "fs";
import Database from "better-sqlite3";
import config from "../config";
import {
    migrate as runMigrations,
    DBAdapter,
    Migration,
    MIGRATION_DIR,
} from "../../script/db";

// Check if we're in worker mode
const isWorkerMode = process.env.TEST_MODE === "worker";

let db: Database.Database | null = null;

/**
 * LocalDBAdapter wrapper for test database
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
 * Initialize test database with migrations
 */
async function init(): Promise<void> {
    if (isWorkerMode) {
        console.log(
            "[WORKER_MODE] init() - database managed by wrangler, no local init needed",
        );
        return;
    }

    if (db) {
        console.log("Database already initialized");
        return;
    }

    console.log("Initializing test database:", config.DB_CONFIG.path);

    // Create database
    db = new Database(config.DB_CONFIG.path);

    // Run migrations using the shared migration logic
    const adapter = new LocalDBAdapter(db);
    await runMigrations(adapter, "test");

    console.log("Test database initialized successfully");
}

/**
 * Cleanup database - remove all data
 */
async function cleanup(): Promise<void> {
    if (isWorkerMode) {
        console.log(
            "[WORKER_MODE] cleanup() - database managed by wrangler, no cleanup needed",
        );
        return;
    }

    if (!db) {
        console.log("Database not initialized, nothing to cleanup");
        return;
    }

    console.log("Cleaning up test database...");

    const tables = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'",
        )
        .all() as { name: string }[];

    for (const table of tables) {
        try {
            db.prepare(`DROP TABLE IF EXISTS ${table.name}`).run();
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
        // In worker mode, clear D1 tables by calling clearD1Tables from globalSetup
        const { clearD1Tables } = await import("../globalSetup.worker");
        clearD1Tables();
        return;
    }

    // Auto-connect if not initialized
    if (!db) {
        db = new Database(config.DB_CONFIG.path);
    }

    console.log("Truncating tables...");

    const tables = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'",
        )
        .all() as { name: string }[];

    for (const table of tables) {
        try {
            db.prepare(`DELETE FROM ${table.name}`).run();
        } catch (e) {
            console.error(`Failed to truncate table ${table.name}:`, e);
        }
    }

    console.log("Tables truncated");
}

/**
 * Execute raw SQL query
 */
function query<T>(sql: string, params: any[] = []): T[] {
    if (isWorkerMode) {
        throw new Error("Direct SQL queries not supported in worker mode");
    }

    if (!db) {
        throw new Error("Database not initialized");
    }

    try {
        return db.prepare(sql).all(...params) as T[];
    } catch (e) {
        console.error("Query failed:", sql, params, e);
        throw e;
    }
}

/**
 * Execute raw SQL statement (insert, update, delete)
 */
function execute(sql: string, params: any[] = []): Database.RunResult {
    if (isWorkerMode) {
        throw new Error("Direct SQL execute not supported in worker mode");
    }

    if (!db) {
        throw new Error("Database not initialized");
    }

    try {
        return db.prepare(sql).run(...params);
    } catch (e) {
        console.error("Execute failed:", sql, params, e);
        throw e;
    }
}

/**
 * Get database instance
 */
function getDB(): Database.Database {
    if (isWorkerMode) {
        throw new Error("getDB not supported in worker mode");
    }

    if (!db) {
        throw new Error("Database not initialized");
    }
    return db;
}

/**
 * Close database connection
 */
function close(): void {
    if (isWorkerMode) {
        console.log(
            "[WORKER_MODE] close() - database managed by wrangler, no close needed",
        );
        return;
    }

    if (db) {
        db.close();
        db = null;
        console.log("Database connection closed");
    }
}

export default {
    init,
    cleanup,
    truncate,
    query,
    execute,
    getDB,
    close,
};
