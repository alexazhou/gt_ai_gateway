import { execSync } from "child_process";
import { DBAdapter, migrate as runMigrations } from "../../script/db";

let dbAdapter: DBAdapter | null = null;

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

/**
 * Initialize test database with migrations
 */
async function init(): Promise<void> {
    if (dbAdapter) {
        console.log("Database already initialized");
        return;
    }

    console.log("Initializing worker test database (wrangler local D1)...");

    dbAdapter = new WorkerDBAdapter();

    // Run migrations using the shared migration logic
    await runMigrations(dbAdapter, "worker-local");

    console.log("Worker test database initialized successfully");
}

/**
 * Cleanup database - remove all data
 */
async function cleanup(): Promise<void> {
    if (!dbAdapter) {
        console.log("Database not initialized, nothing to cleanup");
        return;
    }

    console.log("Cleaning up worker test database...");

    const tables = dbAdapter.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'",
    );

    for (const table of tables) {
        try {
            dbAdapter.exec(`DROP TABLE IF EXISTS ${table.name}`);
        } catch (e) {
            console.error(`Failed to drop table ${table.name}:`, e);
        }
    }

    console.log("Worker database cleaned up");
}

/**
 * Truncate tables - remove all data but keep structure
 */
async function truncate(): Promise<void> {
    // Auto-connect if not initialized
    if (!dbAdapter) {
        dbAdapter = new WorkerDBAdapter();
    }

    console.log("Truncating tables in worker database...");

    const tables = dbAdapter.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'",
    );

    for (const table of tables) {
        try {
            dbAdapter.exec(`DELETE FROM ${table.name}`);
        } catch (e) {
            console.error(`Failed to truncate table ${table.name}:`, e);
        }
    }

    console.log("Worker database tables truncated");
}

/**
 * Execute raw SQL query
 */
function query<T>(sql: string, params: any[] = []): T[] {
    if (!dbAdapter) {
        throw new Error("Database not initialized");
    }

    try {
        return dbAdapter.query<T>(sql);
    } catch (e) {
        console.error("Query failed:", sql, params, e);
        throw e;
    }
}

/**
 * Execute raw SQL statement (insert, update, delete)
 */
function execute(sql: string, params: any[] = []): void {
    if (!dbAdapter) {
        throw new Error("Database not initialized");
    }

    try {
        dbAdapter.run(sql);
    } catch (e) {
        console.error("Execute failed:", sql, params, e);
        throw e;
    }
}

/**
 * Get database adapter instance
 */
function getDB(): DBAdapter {
    if (!dbAdapter) {
        throw new Error("Database not initialized");
    }
    return dbAdapter;
}

/**
 * Close database connection
 */
function close(): void {
    if (dbAdapter) {
        dbAdapter.close();
        dbAdapter = null;
        console.log("Worker database connection closed");
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
