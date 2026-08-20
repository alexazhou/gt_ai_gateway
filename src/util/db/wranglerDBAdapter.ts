import { execSync } from "child_process";
import { DBAdapter } from "./dbAdapter";

export class WranglerDBAdapter implements DBAdapter {
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
        // Instead of passing huge SQL directly on CLI args which can lead to quotes issues,
        // let's try direct --command first
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
