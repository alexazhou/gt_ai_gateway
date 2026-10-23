/**
 * T7 本地 MySQL 门 —— 心跳用例（三条：一条前提 + 两条互为反证）
 *
 * 为什么需要「心跳」而不是「随便跑个用例看看」：
 * `usage` 这类缺陷只在 MySQL 方言下暴露，而 SQLite 下**一切正常**。所以「测试跑绿了」
 * 本身不能证明「我在测 MySQL」—— 必须先有一条断言**只证引擎身份**的用例：
 *
 *   ① `SELECT version()` 必须**成功** → 证明连的是 MySQL 协议引擎（SQLite 没有这个函数）；
 *   ② `SELECT sqlite_version()` 必须**抛错** → 反向报警：真连错引擎（连到 SQLite）时
 *      它必然成功，而此时如果门还"绿着"，说明这条门在骗人。
 *
 * 为什么不用 `@@version`：它在 SQLite 报 `unrecognized token: "@"`，
 * 那是**语法错**不是**引擎错**，会与「SQL 写错」混淆，失去诊断价值（#25 已裁定禁用）。
 *
 * ⚠️ 首版踩到的坑（写在这里免得下一个人重踩）：
 * 第一版用 `dbHelper.query()` 做心跳，结果红在 `Error: Database not initialized` ——
 * vitest 的 `globalSetup` 与 test worker 跑在**不同的模块上下文**里，globalSetup 里
 * `dbHelper.initDatabase()` 建立的 adapter 在用例里是 `undefined`。
 * → 心跳改为**直连**（`mysql2/promise` + 与门完全相同的 `DB_*` 配置），
 *   只回答一个问题：**这个连接指向的是不是 MySQL**。
 *
 * 本文件命名带 `.mysql.`，被 `vitest.config.ts` / `vitest.worker.config.ts` **排除**，
 * 只在 `npm run test:mysql`（`vitest.mysql.config.ts`）下被收集 ——
 * 这样既不会污染 sqlite 全量门的用例计数，也不会在 worker 门里假装通过。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import config from "../../config";

const isMysql = config.DB_CONFIG.driver === "mysql";

let pool: any = null;

describe("MySQL 门心跳（T7）：先证明『连的是 MySQL』，再谈用例是否通过", () => {
    beforeAll(async () => {
        if (!isMysql) return;
        const mysql: any = await import("mysql2/promise");
        const c = config.DB_CONFIG.mysql;
        pool = mysql.createPool({
            host: c.host,
            port: c.port,
            user: c.user,
            password: c.password,
            database: c.database,
            connectionLimit: 1,
            connectTimeout: 5000,
        });
    });

    afterAll(async () => {
        if (pool) await pool.end();
    });

    it("前提：DB_DRIVER=mysql（否则本文件没有意义，直接失败而不是静默跳过）", () => {
        expect(
            isMysql,
            "本文件只能通过 `npm run test:mysql` 运行（它设置 DB_DRIVER=mysql）；" +
                "在 sqlite 方言下跑它得到的任何结论都是假绿。"
        ).toBe(true);
    });

    it("正向：SELECT version() 必须成功（连对的引擎）", async () => {
        const [rows] = await pool.query("SELECT version() AS v");
        const version = String(rows?.[0]?.v ?? "");

        expect(rows.length, "SELECT version() 必须恰好返回一行").toBe(1);
        // MySQL 版本号形如 8.0.44 / 8.4.11；MariaDB 也会命中（同为 MySQL 协议）。
        expect(version, `SELECT version() 的返回值不像 MySQL 版本号：${JSON.stringify(version)}`).toMatch(
            /^\d+\.\d+\.\d+/
        );

        console.log(`[mysql-gate] 引擎探测成功：${version}`);
    });

    it("反向：SELECT sqlite_version() 必须抛错（连错引擎时它必然成功 → 报警）", async () => {
        await expect(
            pool.query("SELECT sqlite_version() AS v"),
            "sqlite_version() 居然能在 MySQL 上执行成功 —— 说明当前连接根本不是 MySQL，" +
                "本门的一切绿色都不可信"
        ).rejects.toThrow();
    });
});
