import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import {
    DBAdapter,
    MIGRATION_DIR,
    MIGRATION_START_MARKER,
    MIGRATION_END_MARKER,
    canonicalMigrationName,
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

interface MigrationState {
    /** _migrations 里的记录（原始行，status 打印 applied_at 用） */
    applied: Migration[];
    /** 迁移目录里的迁移，已排序 */
    available: string[];
    /** 记录里没有的，即待应用 */
    pending: string[];
}

/**
 * 只读读取迁移状态：不建表、不写入。migrate / status 会先自行建好 _migrations 表
 * （它们要写记录），check 刻意不建。
 *
 * 迁移目录读不到时抛错：此时「已应用 / 待应用」无从比对，不能当成"全都应用过了"。
 */
async function readMigrationState(adapter: DBAdapter): Promise<MigrationState> {
    let applied: Migration[] = [];
    try {
        applied = (await adapter.query<Migration>(
            "SELECT name, applied_at FROM _migrations ORDER BY name",
        )) as Migration[];
    } catch {
        // _migrations 不存在（空库）或读取失败：按「没有任何已应用记录」处理
    }

    let available: string[];
    try {
        // 每个迁移一个目录，目录名（如 migrate_0001）即迁移标识
        available = listMigrations(MIGRATION_DIR);
    } catch (e) {
        throw new Error(`Cannot read migrations from ${MIGRATION_DIR}: ${(e as Error).message}`);
    }

    // 兼容旧版记录名（migrate_XXXX.sql），归一化为目录名后再比对
    const appliedNames = new Set(applied.map((row) => canonicalMigrationName(row.name)));

    return {
        applied,
        available,
        pending: available.filter((name) => !appliedNames.has(name)),
    };
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
        console.log("Scanning available migrations in", MIGRATION_DIR);
        const { applied, available, pending } = await readMigrationState(adapter);

        console.log(
            `Applied: ${applied.length}, Available: ${available.length}, Pending: ${pending.length}`,
        );

        if (pending.length === 0) {
            console.log("Database is up to date.");
            success = true;
            return;
        }

        // Worker mode: 合并所有 pending migrations 为一个文件，一次执行
        if (!adapter.execTransaction) {
            console.log(`\n📦 Merging ${pending.length} migrations into single file:`);
            pending.forEach((name, i) => console.log(`   ${i + 1}. ${name}`));

            mkdirSync(TMP_DIR, { recursive: true });
            const tmpFile = join(TMP_DIR, `migration_${crypto.randomUUID()}.sql`);

            let combinedSql = "";
            for (const name of pending) {
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
            console.log(`✅ Successfully applied ${pending.length} migrations in one batch`);
        } else {
            // Node mode: 用事务逐个执行
            for (const name of pending) {
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

export async function initDB(adapter: DBAdapter, env: string) {
    console.log(`\nInitializing database in ${env}...`);
    // The database connection automatically creates the file if it doesn't exist.
    // We just need to execute the migrations.
    await migrate(adapter, env);
    console.log(`\nDatabase initialized successfully.`);
}

export async function status(adapter: DBAdapter) {
    const { applied, available, pending } = await readMigrationState(adapter);

    console.log(`\n=== Migration Status ===`);

    if (available.length === 0) {
        console.log("No migrations found in resource/migrate.");
        return;
    }

    const appliedMap = new Map<string, string>();
    // 同样归一化旧版记录名，确保旧库的 status 也能正确显示已应用状态
    applied.forEach((m) => appliedMap.set(canonicalMigrationName(m.name), m.applied_at || "unknown"));

    available.forEach((file) => {
        if (appliedMap.has(file)) {
            console.log(`✅ ${file} (Applied at: ${appliedMap.get(file)})`);
        } else {
            console.log(`[ ] ${file} (Pending)`);
        }
    });

    const version = applied.length > 0 ? parseInt(applied[applied.length - 1].name.replace(/\D/g, ""), 10) || 0 : 0;

    console.log(`\nCurrent Database Version: ${version}`);
    console.log(`Migrations to apply: ${pending.length}`);
}

/**
 * clear 会删掉的表：按白名单列出，而不是"列出库里所有表再排除"——后者一旦库里出现
 * 未预期的表（外部工具建的、以后新增的），就可能被顺手删掉。
 *
 * 迁移新增业务表时要同步补进来，tests/unit/service/dbMigrationService.test.ts 里有一条
 * 用例钉住「白名单覆盖迁移建出的全部业务表」。
 *
 * _migrations 一并删：只删业务表会让记录说"已迁移"而表已不在，之后 migrate 什么都不做。
 */
export const DROPPABLE_TABLES = [
    "client_config",
    "config",
    "model",
    "recharge_records",
    "record",
    "request_activity",
    "rule",
    "storage_record",
    "tenant",
    "user",
    "vendor",
    "vendor_model",
    "_migrations",
];

export async function clear(adapter: DBAdapter, env: string) {
    const dialect = getDialect(env);
    // 注意：这个操作很危险
    console.warn(
        `\n⚠️  WARNING: You are about to CLEAR the database in environment: ${env}`,
    );
    console.warn(`网关自己的表会被 DROP（含 _migrations，迁移记录一并清掉）。\n`);

    // 取白名单里真实存在的表：不存在的跳过，确认提示里也只列真会被删的
    let existing: Set<string>;
    try {
        const rows = (await adapter.query<{ name: string }>(
            dialect === "mysql"
                ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()"
                : "SELECT name FROM sqlite_master WHERE type='table'",
        )) as any[];
        existing = new Set(rows.map((row) => row.name));
    } catch (e) {
        console.error("Failed to query tables:", e);
        return;
    }

    const tables = DROPPABLE_TABLES.filter((name) => existing.has(name));

    if (tables.length === 0) {
        console.log("No tables to drop.");
        return;
    }

    console.log(`Found ${tables.length} tables to drop:`, tables.join(", "));

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

    for (const name of tables) {
        try {
            console.log(`Dropping table: ${name}...`);
            await adapter.exec(`DROP TABLE IF EXISTS ${name}`);
        } catch (e) {
            console.error(`Failed to drop table ${name}:`, e);
        }
    }

    console.log("\nDatabase cleared.");
}

// 清理临时迁移文件（worker 合并路径使用）
export async function clearTempDir(): Promise<void> {
    try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}

// ─── 启动时的迁移策略（ormService 调）───

export type MigrationMode = "execute" | "check" | "off";

/**
 * 启动时的迁移策略，读环境变量 MIGRATION_MODE：
 * execute（默认）应用待执行的迁移；check 只比对记录、不写库；off 完全跳过。
 *
 * 取值非法直接抛错：拼错（如 checks）不能静默退化成 execute——那会在本该"只检查"的
 * 部署里把迁移执行掉。
 */
export function getMigrationMode(): MigrationMode {
    const raw = (process.env.MIGRATION_MODE || "execute").trim().toLowerCase();
    if (raw === "execute" || raw === "check" || raw === "off") {
        return raw;
    }
    throw new Error(
        `Invalid MIGRATION_MODE: "${process.env.MIGRATION_MODE}" (expected execute / check / off)`,
    );
}

/**
 * 只读比对：返回已应用与待应用的迁移名，不修改数据库。
 * 与 migrate() / status() 共用 readMigrationState()，区别只在于这里不建 _migrations 表。
 */
export async function check(
    adapter: DBAdapter,
): Promise<{ applied: string[]; pending: string[] }> {
    const { applied, pending } = await readMigrationState(adapter);

    return { applied: applied.map((row) => canonicalMigrationName(row.name)), pending };
}

/**
 * 启动时的迁移：按 getMigrationMode() 的三种取值处理，node 模式下由 ormService.init 调。
 *
 * execute 应用待执行的迁移；check 只比对记录、落后就抛错（调用方的启动流程会因此中断）；
 * off 完全跳过。worker 模式不走这里——D1 的迁移由 wrangler 负责。
 */
export async function applyStartupMigrations(adapter: DBAdapter): Promise<void> {
    const mode = getMigrationMode();

    if (mode === "off") {
        console.log("[DB MIGRATION] MIGRATION_MODE=off: skipping migrations and checks.");
        return;
    }

    if (mode === "execute") {
        await migrate(adapter, "node");
        return;
    }

    const { applied, pending } = await check(adapter);
    if (pending.length === 0) {
        console.log(
            `[DB MIGRATION] MIGRATION_MODE=check: database is up to date (${applied.length} applied).`,
        );
        return;
    }

    throw new Error(
        `Database is behind: ${pending.length} pending migration(s) (${pending.join(", ")}). `
            + `This deployment runs with MIGRATION_MODE=check, so apply them first `
            + `(npm run db:migrate:node), or switch to MIGRATION_MODE=execute.`,
    );
}

export default {
    migrate,
    status,
    check,
    applyStartupMigrations,
    DROPPABLE_TABLES,
    getMigrationMode,
    clear,
    initDB,
    createDBAdapter,
    mysqlConnFromEnv,
    clearTempDir,
    MIGRATION_DIR,
};
