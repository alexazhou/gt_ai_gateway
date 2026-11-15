import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DBAdapter } from "./dbAdapter";
import { assertSafeCliArg } from "./cliArgUtil";

// 超过该长度的 SQL 走临时文件（argv 长度上限因平台而异，Windows 约 32KB）
const INLINE_SQL_LIMIT = 32 * 1024;

export class WranglerDBAdapter implements DBAdapter {
    private target: "--local" | "--remote";
    private configPath: string;
    private dbName: string;

    constructor(target: "--local" | "--remote", configPath: string = "", dbName: string = "gt_ai_gateway") {
        this.target = target;
        this.configPath = configPath;
        this.dbName = dbName;
        assertSafeCliArg(dbName, "dbName");
        assertSafeCliArg(configPath, "configPath");
    }

    private buildArgs(extra: string[]): string[] {
        assertSafeCliArg(this.dbName, "dbName");
        const args = ["wrangler", "d1", "execute", this.dbName, this.target];
        if (this.configPath) {
            assertSafeCliArg(this.configPath, "configPath");
            args.push("--config", this.configPath);
        }
        args.push(...extra);
        return args;
    }

    /**
     * 用 execFileSync + argv 数组调用 npx，**不经过 shell**：
     * SQL 里的 `$()`、反引号、`;`、引号都只是普通字节，不会被解释成命令。
     * 修复前是 execSync 拼字符串（只转义双引号），存在命令注入。
     */
    private runWrangler(extra: string[]): string {
        const args = this.buildArgs(extra);
        console.log(`> npx ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
        try {
            return execFileSync("npx", args, { encoding: "utf-8", stdio: "pipe" });
        } catch (e) {
            const error = e as { message?: string; stdout?: unknown; stderr?: unknown };
            console.error("Wrangler command failed:", error.message);
            if (error.stdout) console.error("stdout:", error.stdout);
            if (error.stderr) console.error("stderr:", error.stderr);
            throw e;
        }
    }

    /**
     * 执行 SQL：短 SQL 走 `--command`，超长走临时文件 `--file`（避免 argv 上限）。
     * 两种方式都以独立 argv 元素传递，SQL 内容不再被 shell 解析，也不再对换行做替换
     * （原实现把 `\n` 换成空格，会改坏 SQL 字符串字面量里的换行）。
     */
    private runWithSql(sql: string, extra: string[] = []): string {
        if (sql.length <= INLINE_SQL_LIMIT) {
            return this.runWrangler([...extra, "--command", sql]);
        }

        const dir = mkdtempSync(join(tmpdir(), "gtgw-sql-"));
        const file = join(dir, "query.sql");
        try {
            writeFileSync(file, sql, "utf-8");
            return this.runWrangler([...extra, "--file", file]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    exec(sql: string): void {
        this.runWithSql(sql);
    }

    query<T>(sql: string): T[] {
        // Wrangler --json output format: [{results: [...], success: true, ...}]
        const output = this.runWithSql(sql, ["--json"]);
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
