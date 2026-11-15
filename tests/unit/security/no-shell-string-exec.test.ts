import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * 安全守卫：src/ 下禁止出现「shell 字符串执行」。
 *
 * 背景（P0-1 修复的边界）：
 * - `src/util/db/wranglerDBAdapter.ts` 已改为 `execFileSync("npx", argv[])`，不再进 shell；
 * - 但 `src/service/dbMigrationService.ts` 的「合并 pending migrations 后一次执行」分支
 *   （`if (!adapter.execTransaction)`，即 D1 / wrangler 路径）仍在用
 *   `execSync(\`npx wrangler d1 execute ${dbName} ...\`)` 拼字符串，
 *   `dbName` / `configPath` 来自 CLI 参数（`script/db.ts --db-name / --config`）→ 同类命令注入仍在。
 *
 * 因此这条守卫在修复前是**故意红**的：它把"还有一处没改"钉在测试里，
 * 避免 P0-1 以"改了一个调用点"收尾。修复后应全绿，并同时满足：
 *   1. 该分支改用 `execFileSync("npx", ["wrangler","d1","execute",dbName,target,"--config",configPath,"--file",tmpFile])`；
 *   2. dbName / configPath 复用 wranglerDBAdapter 的白名单校验（建议把 assertSafeArg 抽成共享 util）。
 */

const SRC_DIR = join(process.cwd(), "src");

function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...listTsFiles(full));
            continue;
        }
        if (entry.endsWith(".ts")) {
            out.push(full);
        }
    }
    return out;
}

/** 去掉块注释与整行注释，避免把注释里的文字当成代码 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith("//") && !trimmed.startsWith("*");
        })
        .join("\n");
}

describe("安全守卫：src/ 不得使用 shell 字符串执行命令", () => {
    const files = listTsFiles(SRC_DIR);

    it("src/ 下不存在 execSync / exec(string) 形式的子进程调用", () => {
        const offenders: { file: string; line: number; code: string }[] = [];

        for (const file of files) {
            const code = stripComments(readFileSync(file, "utf-8"));
            code.split("\n").forEach((line, idx) => {
                // execSync(...) 或 child_process.exec("...")（参数为拼接字符串）
                // 注意排除 `adapter.exec("SQL")` 这类数据库方法调用（紧跟 `.` 的不是 child_process）
                const hasExecSync = /\bexecSync\s*\(/.test(line);
                const hasShellExec = /(?<![.\w])exec\s*\(\s*["'`]/.test(line);
                if (hasExecSync || hasShellExec) {
                    offenders.push({
                        file: relative(process.cwd(), file),
                        line: idx + 1,
                        code: line.trim(),
                    });
                }
            });
        }

        expect(
            offenders,
            `发现 shell 字符串执行（命令注入面）：\n${offenders
                .map((o) => `  ${o.file}:${o.line}  ${o.code}`)
                .join("\n")}\n应改用 execFileSync(cmd, argv[]) 并以独立参数传值。`,
        ).toEqual([]);
    });

    it("只有 dbMigrationService 可以实例化 WranglerDBAdapter（请求链路不得触达子进程）", () => {
        const users = files
            .filter((file) => /new\s+WranglerDBAdapter\s*\(/.test(stripComments(readFileSync(file, "utf-8"))))
            .map((file) => relative(process.cwd(), file))
            .sort();

        expect(users).toEqual(["src/service/dbMigrationService.ts"]);
    });
});
