import { join } from "path";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
export const MIGRATION_DIR = process.env.MIGRATION_DIR || join(process.cwd(), "resource", "migrate");
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
export interface DBAdapter {
    exec(sql: string): void;
    query<T>(sql: string): T[];
    run(sql: string, ...params: any[]): void;
    close(): void;
    execTransaction?(sqls: string[]): void;
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
        return new LocalDBAdapter(LOCAL_DB_PATH);
    } else if (env === "worker-local") {
        return new WranglerDBAdapter("--local", dbConfigPath, dbName);
    } else if (env === "worker-cloud") {
        return new WranglerDBAdapter("--remote", dbConfigPath, dbName);
    } else {
        throw new Error(`Unknown env: ${env}`);
    }
}

// 命令实现
export async function migrate(adapter: DBAdapter, env: string) {
    console.log(`Initializing migrations table in ${env}...`);
    adapter.exec(
        "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );

    console.log("Fetching applied migrations...");
    let applied: Migration[] = [];
    try {
        applied = adapter.query<Migration>(
            "SELECT name FROM _migrations ORDER BY name",
        );
    } catch (e) {
        console.log("Error fetching applied migrations, assuming empty.", e);
    }

    const appliedNames = new Set(applied.map((m) => m.name));

    console.log("Scanning available migrations in", MIGRATION_DIR);
    let available: string[] = [];
    try {
        available = readdirSync(MIGRATION_DIR).filter((f) =>
            f.endsWith(".sql"),
        );
    } catch (e) {
        console.warn(`Could not read migration directory: ${MIGRATION_DIR}`);
    }

    // 过滤并排序
    const validFiles = available.filter((f) => /(\d{4})\.sql$/.test(f)).sort();

    const pendingMigrations = validFiles.filter(
        (name) => !appliedNames.has(name),
    );

    console.log(
        `Applied: ${applied.length}, Available: ${validFiles.length}, Pending: ${pendingMigrations.length}`,
    );

    if (pendingMigrations.length === 0) {
        console.log("Database is up to date.");
        return;
    }

    for (const file of pendingMigrations) {
        console.log(`\nApplying migration: ${file}...`);
        const sqlPath = join(MIGRATION_DIR, file);
        const sql = readFileSync(sqlPath, "utf-8");

        const insertRecord = `INSERT INTO _migrations (name) VALUES ('${file}')`;

        try {
            if (!adapter.execTransaction) {
                // 把 migration SQL 和记录插入合并到一个临时文件，一次提交
                mkdirSync(TMP_DIR, { recursive: true });
                const tmpFile = join(TMP_DIR, `migration_${crypto.randomUUID()}.sql`);
                writeFileSync(tmpFile, `${sql}\n${insertRecord};`, "utf-8");
                let cmd = `npx wrangler d1 execute ${dbName} ${env === "worker-cloud" ? "--remote" : "--local"}`;
                if (dbConfigPath) {
                    cmd += ` --config ${dbConfigPath}`;
                }
                cmd += ` --file="${tmpFile}"`;
                console.log(`> ${cmd}`);
                execSync(cmd, { stdio: "inherit" });
            } else {
                // 用事务把 migration SQL 和记录插入打包执行
                adapter.execTransaction!([sql, insertRecord]);
            }
            console.log(`✅ Successfully applied: ${file}`);
        } catch (e) {
            console.error(`❌ Failed to apply migration ${file}:`, e);
            throw e;
        }
    }

    console.log("\nAll pending migrations applied.");
}

async function status(adapter: DBAdapter) {
    console.log("Initializing migrations table...");
    adapter.exec(
        "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );

    let applied: Migration[] = [];
    try {
        applied = adapter.query<Migration>(
            "SELECT name, applied_at FROM _migrations ORDER BY name",
        );
    } catch (e) {
        console.log("Error fetching applied migrations", e);
    }

    let available: string[] = [];
    try {
        available = readdirSync(MIGRATION_DIR).filter((f) =>
            f.endsWith(".sql"),
        );
    } catch (e) {
        console.warn(`Could not read migration directory: ${MIGRATION_DIR}`);
    }

    const validFiles = available.filter((f) => /(\d{4})\.sql$/.test(f)).sort();

    console.log(`\n=== Migration Status ===`);

    if (validFiles.length === 0) {
        console.log("No migration files found in resource/migrate.");
        return;
    }

    const appliedMap = new Map<string, string>();
    applied.forEach((m) => appliedMap.set(m.name, m.applied_at || "unknown"));

    validFiles.forEach((file) => {
        if (appliedMap.has(file)) {
            console.log(`✅ ${file} (Applied at: ${appliedMap.get(file)})`);
        } else {
            console.log(`[ ] ${file} (Pending)`);
        }
    });

    const lastApplied = applied.length > 0 ? applied[applied.length - 1] : null;
    const version = lastApplied
        ? parseInt(lastApplied.name.match(/(\d{4})\.sql$/)?.[1] || "0", 10)
        : 0;

    console.log(`\nCurrent Database Version: ${version}`);
    console.log(`Migrations to apply: ${validFiles.length - applied.length}`);
}

async function clear(adapter: DBAdapter, env: string) {
    // 注意：这个操作很危险
    console.warn(
        `\n⚠️  WARNING: You are about to CLEAR the database in environment: ${env}`,
    );
    console.warn(
        `All tables EXCEPT sqlite_schema / d1 internal tables will be DROPPED.\n`,
    );

    let tables: any[] = [];
    try {
        tables = adapter.query<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
        );
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
            adapter.exec(`DROP TABLE IF EXISTS ${table.name}`);
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
                await status(adapter);
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
