import { join } from "path";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
export const MIGRATION_DIR = process.env.MIGRATION_DIR || join(process.cwd(), "resource", "migrate");
export const MIGRATION_START_MARKER = "[GT_AI_GATEWAY_MIGRATION_START]";
export const MIGRATION_END_MARKER = "[GT_AI_GATEWAY_MIGRATION_END]";
const LOCAL_DB_PATH = process.env.DB_PATH || join(process.cwd(), "local.db");
const TMP_DIR = join(process.cwd(), ".tmp");

export interface Migration {
    id?: number;
    name: string;
    applied_at?: string;
}

// 解析命令行参数
let command = "";
let env = "node"; // default
let dbConfigPath = ""; // optional custom wrangler config
let dbName = "DB"; // default D1 binding name

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" || args[i] === "-e") {
        env = args[i + 1];
        i++;
    } else if (args[i] === "--config" || args[i] === "-c") {
        dbConfigPath = args[i + 1];
        i++;
    } else if (args[i] === "--db-name") {
        dbName = args[i + 1];
        i++;
    } else if (!command) {
        command = args[i];
    }
}

// 统一的执行 SQL 接口
// 允许异步（MySQL 适配器），同步适配器（SQLite）返回普通值，await 同样生效
export interface DBAdapter {
    exec(sql: string): Promise<void> | void;
    query<T>(sql: string): Promise<T[]> | T[];
    run(sql: string, ...params: any[]): Promise<void> | void;
    close(): Promise<void> | void;
    execTransaction?(sqls: string[]): Promise<void> | void;
}

// 当前方言：node 模式由 DB_DRIVER 决定（默认 sqlite），worker(D1) 始终为 sqlite 方言
function getDialect(env: string): "sqlite" | "mysql" {
    if (env === "node") {
        return process.env.DB_DRIVER === "mysql" ? "mysql" : "sqlite";
    }
    return "sqlite"; // worker 走 D1，与 sqlite 同方言
}

// 一个迁移目录下、当前方言应执行的文件（方言文件优先，无则回退 common.sql）
function migrationSqlFile(dir: string, dialect: "sqlite" | "mysql"): string {
    const candidates =
        dialect === "mysql" ? ["mysql.sql", "common.sql"] : ["sqlite.sql", "common.sql"];
    for (const f of candidates) {
        const p = join(dir, f);
        if (existsSync(p)) return p;
    }
    throw new Error(`Migration ${dir} has no SQL file for dialect ${dialect}`);
}

// 列出所有迁移目录（按名字排序，如 migrate_0001 … migrate_0028）
function listMigrations(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^migrate_\d{4}$/.test(d.name))
        .map((d) => d.name)
        .sort();
}

class LocalDBAdapter implements DBAdapter {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
    }

    exec(sql: string): void {
        const statements = sql
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        // 对于 sqlite3，多条语句可能导致问题，因此尝试分拆或者使用 .exec() 完整执行
        // better-sqlite3 推荐使用 .exec 执行包含多条语句的完整字符串
        try {
            this.db.exec(sql);
        } catch (e) {
            // 回退分拆单条执行
            for (const statement of statements) {
                if (statement) {
                    this.db.exec(statement + ";");
                }
            }
        }
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

class MySQLDBAdapter implements DBAdapter {
    private pool: any;

    constructor(conn: any) {
        // mysql2/promise 的 createPool 同步返回连接池，各方法异步执行
        // multipleStatements: true —— 迁移文件常含多条语句，交由 exec 一次执行
        const mysql = require("mysql2/promise");
        this.pool = mysql.createPool({
            host: conn.host,
            port: conn.port,
            user: conn.user,
            password: conn.password,
            database: conn.database,
            connectionLimit: 10,
            multipleStatements: true,
            charset: "utf8mb4",
            dateStrings: true,
        });
    }

    private async withConn<T>(fn: (c: any) => Promise<T>): Promise<T> {
        const c = await this.pool.getConnection();
        try {
            return await fn(c);
        } finally {
            c.release();
        }
    }

    async exec(sql: string): Promise<void> {
        await this.withConn(async (c) => c.query(sql));
    }

    async query<T>(sql: string): Promise<T[]> {
        return this.withConn(async (c) => {
            const [rows] = await c.query(sql);
            return rows as T[];
        });
    }

    async run(sql: string, ...params: any[]): Promise<void> {
        await this.withConn(async (c) => c.execute(sql, params));
    }

    async execTransaction(sqls: string[]): Promise<void> {
        await this.withConn(async (c) => {
            try {
                await c.beginTransaction();
                for (const s of sqls) {
                    await c.query(s);
                }
                await c.commit();
            } catch (e) {
                await c.rollback();
                throw e;
            }
        });
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

class WranglerDBAdapter implements DBAdapter {
    private target: "--local" | "--remote";
    private configPath: string;
    private dbName: string;

    constructor(target: "--local" | "--remote", configPath: string = "", dbName: string = "gt_ai_gateway") {
        this.target = target;
        this.configPath = configPath;
        this.dbName = dbName;
    }

    private runWrangler(args: string[]): string {
        let cmd = `npx wrangler d1 execute ${this.dbName} ${this.target}`;
        if (this.configPath) {
            cmd += ` --config ${this.configPath}`;
        }
        cmd += ` ${args.join(" ")}`;
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
        // Escape shell payload, or better interact via file
        // Due to the complexity of sending arbitrary SQL over the CLI via an argument:
        // We'll use a temporary file or format it
        // Wrangler accepts --command="SQL"

        // Instead of passing huge SQL directly on CLI args which can lead to quotes issues,
        // let's try direct --command first
        // Note: D1 execute does not like multi-line queries via command sometimes
        const singleLine = sql.replace(/\n/g, " ");
        this.runWrangler([`--command="${singleLine.replace(/"/g, '\\"')}"`]);
    }

    query<T>(sql: string): T[] {
        // Wrangler --json output format: [{results: [...], success: true, ...}]
        const output = this.runWrangler([
            `--json --command="${sql.replace(/"/g, '\\"')}"`,
        ]);
        try {
            const match = output.match(/\[.*\]/s);
            if (match) {
                const parsed = JSON.parse(match[0]);
                // wrangler d1 returns [{results: [...]}], extract the actual rows
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
        // No-op
    }
}

function getAdapter(env: string): DBAdapter {
    if (env === "node") {
        if (getDialect(env) === "mysql") {
            return new MySQLDBAdapter({
                host: process.env.DB_HOST || "127.0.0.1",
                port: parseInt(process.env.DB_PORT || "3306", 10),
                user: process.env.DB_USER || "",
                password: process.env.DB_PASSWORD || "",
                database: process.env.DB_NAME || "",
            });
        }
        return new LocalDBAdapter(LOCAL_DB_PATH);
    } else if (env === "worker-local") {
        return new WranglerDBAdapter("--local", dbConfigPath, dbName);
    } else if (env === "worker-cloud") {
        return new WranglerDBAdapter("--remote", dbConfigPath, dbName);
    } else {
        throw new Error(`Unknown env: ${env}`);
    }
}

// _migrations 记录表 DDL（按方言）
function migrationsTableDdl(dialect: "sqlite" | "mysql"): string {
    return dialect === "mysql"
        ? "CREATE TABLE IF NOT EXISTS _migrations (id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
        : "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";
}

// 命令实现
export async function migrate(adapter: DBAdapter, env: string) {
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
            let cmd = `npx wrangler d1 execute ${dbName} ${env === "worker-cloud" ? "--remote" : "--local"}`;
            if (dbConfigPath) {
                cmd += ` --config ${dbConfigPath}`;
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

async function status(adapter: DBAdapter, env: string) {
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

async function clear(adapter: DBAdapter, env: string) {
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

async function init(adapter: DBAdapter, env: string) {
    console.log(`\nInitializing database in ${env}...`);
    // The database connection automatically creates the file if it doesn't exist.
    // We just need to execute the migrations.
    await migrate(adapter, env);
    console.log(`\nDatabase initialized successfully.`);
}

// 主入口
async function main() {
    if (!command) {
        console.error(
            "Usage: npx tsx script/db.ts <command> [--env node|worker-local|worker-cloud]",
        );
        console.error("Commands: migrate, status, clear, init");
        process.exit(1);
    }

    if (!["node", "worker-local", "worker-cloud"].includes(env)) {
        console.error(
            `Invalid environment: ${env}. Must be node, worker-local, or worker-cloud.`,
        );
        process.exit(1);
    }

    console.log(`=== DB Automation Script ===`);
    console.log(`Command: ${command}`);
    console.log(`Environment: ${env}`);
    console.log(`============================\n`);

    let adapter: DBAdapter;
    try {
        adapter = getAdapter(env);
    } catch (e: any) {
        console.error("Failed to initialize database adapter:", e.message);
        process.exit(1);
    }

    try {
        switch (command) {
            case "migrate":
                await migrate(adapter, env);
                break;
            case "status":
                await status(adapter, env);
                break;
            case "clear":
                await clear(adapter, env);
                break;
            case "init":
                await init(adapter, env);
                break;
            default:
                console.error(`Unknown command: ${command}`);
                console.log("Available commands: migrate, status, clear, init");
                process.exit(1);
        }
    } catch (e) {
        console.error("\nExecution failed:");
        console.error(e);
        process.exit(1);
    } finally {
        adapter.close();
        try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
    }
}

// Only run main() if this file is executed directly as a CLI script.
// require.main === module is unreliable when bundled with esbuild (always true at top level).
// Use argv[1] instead: when run as `npx tsx script/db.ts`, argv[1] contains 'db.ts'.
const _scriptPath = process.argv[1] || "";
if (_scriptPath.endsWith("db.ts") || _scriptPath.endsWith("db.js") || _scriptPath.includes("/script/db")) {
    main();
}

export default { migrate, LocalDBAdapter, MIGRATION_DIR };
