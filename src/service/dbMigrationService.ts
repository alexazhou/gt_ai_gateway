import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import {
    DBAdapter,
    MIGRATION_DIR,
    MIGRATION_START_MARKER,
    MIGRATION_END_MARKER,
    getDialect,
    migrationSqlFile,
    listMigrations,
    migrationsTableDdl,
} from "../util/db/dbAdapter";
import { SQLiteDBAdapter } from "../util/db/sqliteDBAdapter";
import { MySQLDBAdapter, MySQLConnOptions } from "../util/db/mysqlDBAdapter";
import { WranglerDBAdapter } from "../util/db/wranglerDBAdapter";

const LOCAL_DB_PATH = process.env.DB_PATH || join(process.cwd(), "local.db");
const TMP_DIR = join(process.cwd(), ".tmp");

export interface Migration {
    id?: number;
    name: string;
    applied_at?: string;
}

// 从环境变量读取 MySQL 连接参数（DB_URL 优先于离散变量）
export function mysqlConnFromEnv(): MySQLConnOptions {
    if (process.env.DB_URL) {
        return { uri: process.env.DB_URL };
    }
    return {
        host: process.env.DB_HOST || "127.0.0.1",
        port: parseInt(process.env.DB_PORT || "3306", 10),
        user: process.env.DB_USER || "",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_NAME || "",
    };
}

// 工厂：按 env 与 DB_DRIVER 创建对应的 DBAdapter
export function createDBAdapter(
    env: string,
    options: { configPath?: string; dbName?: string } = {},
): DBAdapter {
    if (env === "node" || env === "test") {
        if (getDialect(env) === "mysql") {
            return new MySQLDBAdapter(mysqlConnFromEnv());
        }
        return new SQLiteDBAdapter(LOCAL_DB_PATH);
    } else if (env === "worker-local") {
        return new WranglerDBAdapter("--local", options.configPath || "", options.dbName || "gt_ai_gateway");
    } else if (env === "worker-cloud") {
        return new WranglerDBAdapter("--remote", options.configPath || "", options.dbName || "gt_ai_gateway");
    } else {
        throw new Error(`Unknown env: ${env}`);
    }
}

export async function migrate(
    adapter: DBAdapter,
    env: string,
    options: { dbName?: string; configPath?: string } = {},
) {
    const dialect = getDialect(env);
    console.log(`${MIGRATION_START_MARKER} env=${env} dialect=${dialect}`);
    let success = false;

    try {
        console.log(`Initializing migrations table in ${env}...`);
        await adapter.exec(migrationsTableDdl(dialect));

        console.log("Fetching applied migrations...");
        let applied: Migration[] = [];
        try {
            applied = (await adapter.query<Migration>(
                "SELECT name FROM _migrations ORDER BY name",
            )) as Migration[];
        } catch (e) {
            console.log("Error fetching applied migrations, assuming empty.", e);
        }

        const appliedNames = new Set(applied.map((m) => m.name));

        console.log("Scanning available migrations in", MIGRATION_DIR);
        let pendingMigrations: string[] = [];
        try {
            // 每个迁移一个目录，目录名（如 migrate_0001）即迁移标识
            pendingMigrations = listMigrations(MIGRATION_DIR).filter(
                (name) => !appliedNames.has(name),
            );
        } catch (e) {
            console.warn(`Could not read migration directory: ${MIGRATION_DIR}`);
        }

        const availableCount = listMigrations(MIGRATION_DIR).length;

        console.log(
            `Applied: ${applied.length}, Available: ${availableCount}, Pending: ${pendingMigrations.length}`,
        );

        if (pendingMigrations.length === 0) {
            console.log("Database is up to date.");
            success = true;
            return;
        }

        // Worker mode: 合并所有 pending migrations 为一个文件，一次执行
        if (!adapter.execTransaction) {
            console.log(`\n📦 Merging ${pendingMigrations.length} migrations into single file:`);
            pendingMigrations.forEach((name, i) => console.log(`   ${i + 1}. ${name}`));

            mkdirSync(TMP_DIR, { recursive: true });
            const tmpFile = join(TMP_DIR, `migration_${crypto.randomUUID()}.sql`);

            let combinedSql = "";
            for (const name of pendingMigrations) {
                const sql = readFileSync(migrationSqlFile(join(MIGRATION_DIR, name), dialect), "utf-8");
                combinedSql += `${sql}\n`;
                combinedSql += `INSERT INTO _migrations (name) VALUES ('${name}');\n`;
            }

            writeFileSync(tmpFile, combinedSql, "utf-8");
            let cmd = `npx wrangler d1 execute ${options.dbName || "gt_ai_gateway"} ${env === "worker-cloud" ? "--remote" : "--local"}`;
            if (options.configPath) {
                cmd += ` --config ${options.configPath}`;
            }
            cmd += ` --file="${tmpFile}"`;
            console.log(`\n🚀 Executing combined migration file...`);
            execSync(cmd, { stdio: "inherit" });
            console.log(`✅ Successfully applied ${pendingMigrations.length} migrations in one batch`);
        } else {
            // Node mode: 用事务逐个执行
            for (const name of pendingMigrations) {
                console.log(`\nApplying migration: ${name}...`);
                const sql = readFileSync(migrationSqlFile(join(MIGRATION_DIR, name), dialect), "utf-8");
                const insertRecord = `INSERT INTO _migrations (name) VALUES ('${name}')`;

                try {
                    await adapter.execTransaction!([sql, insertRecord]);
                    console.log(`✅ Successfully applied: ${name}`);
                } catch (e) {
                    console.error(`❌ Failed to apply migration ${name}:`, e);
                    throw e;
                }
            }
        }

        console.log("\nAll pending migrations applied.");
        success = true;
    } finally {
        const status = success ? "success" : "failed";
        console.log(`${MIGRATION_END_MARKER} env=${env} status=${status}`);
    }
}

export async function status(adapter: DBAdapter, env: string) {
    const dialect = getDialect(env);
    console.log("Initializing migrations table...");
    await adapter.exec(migrationsTableDdl(dialect));

    let applied: Migration[] = [];
    try {
        applied = (await adapter.query<Migration>(
            "SELECT name, applied_at FROM _migrations ORDER BY name",
        )) as Migration[];
    } catch (e) {
        console.log("Error fetching applied migrations", e);
    }

    let migs: string[] = [];
    try {
        migs = listMigrations(MIGRATION_DIR);
    } catch (e) {
        console.warn(`Could not read migration directory: ${MIGRATION_DIR}`);
    }

    console.log(`\n=== Migration Status ===`);

    if (migs.length === 0) {
        console.log("No migrations found in resource/migrate.");
        return;
    }

    const appliedMap = new Map<string, string>();
    applied.forEach((m) => appliedMap.set(m.name, m.applied_at || "unknown"));

    migs.forEach((file) => {
        if (appliedMap.has(file)) {
            console.log(`✅ ${file} (Applied at: ${appliedMap.get(file)})`);
        } else {
            console.log(`[ ] ${file} (Pending)`);
        }
    });

    const version = applied.length > 0 ? parseInt(applied[applied.length - 1].name.replace(/\D/g, ""), 10) || 0 : 0;

    console.log(`\nCurrent Database Version: ${version}`);
    console.log(`Migrations to apply: ${migs.length - applied.length}`);
}

export async function clear(adapter: DBAdapter, env: string) {
    const dialect = getDialect(env);
    // 注意：这个操作很危险
    console.warn(
        `\n⚠️  WARNING: You are about to CLEAR the database in environment: ${env}`,
    );
    console.warn(
        `All tables EXCEPT sqlite_schema / mysql system tables will be DROPPED.\n`,
    );

    // 按方言列出业务表：sqlite 用 sqlite_master，mysql 用 information_schema
    const listSql =
        dialect === "mysql"
            ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name NOT LIKE '\\_%'"
            : "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'";

    let tables: any[] = [];
    try {
        tables = (await adapter.query<{ name: string }>(listSql)) as any[];
    } catch (e) {
        console.error("Failed to query tables:", e);
        return;
    }

    if (tables.length === 0) {
        console.log("No custom tables found to drop.");
        return;
    }

    console.log(
        `Found ${tables.length} tables to drop:`,
        tables.map((t) => t.name).join(", "),
    );

    // 用户确认
    const confirmed = await new Promise<boolean>((resolve) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question("Are you sure? (y/N): ", (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });

    if (!confirmed) {
        console.log("Aborted.");
        return;
    }

    for (const table of tables) {
        try {
            console.log(`Dropping table: ${table.name}...`);
            await adapter.exec(`DROP TABLE IF EXISTS ${table.name}`);
        } catch (e) {
            console.error(`Failed to drop table ${table.name}:`, e);
        }
    }

    console.log("\nDatabase cleared.");
}

export async function init(adapter: DBAdapter, env: string) {
    console.log(`\nInitializing database in ${env}...`);
    // The database connection automatically creates the file if it doesn't exist.
    // We just need to execute the migrations.
    await migrate(adapter, env);
    console.log(`\nDatabase initialized successfully.`);
}

// 清理临时迁移文件（worker 合并路径使用）
export async function clearTempDir(): Promise<void> {
    try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}

export default {
    migrate,
    status,
    clear,
    init,
    createDBAdapter,
    mysqlConnFromEnv,
    clearTempDir,
    MIGRATION_DIR,
};
