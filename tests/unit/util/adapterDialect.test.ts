import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { adapterDialectOf, D1Adapter, MySQLAdapter, SQLiteAdapter } from "../../../src/util/dbAdapterUtil";

/**
 * 方言必须跟着「实际执行 SQL 的适配器」走，不能跟着 `process.env.DB_DRIVER` 走。
 *
 * 现场（CI MySQL 门）：`DB_DRIVER=mysql` 但单测注入的是 better-sqlite3 适配器，
 * 旧实现按环境变量拼出 `ON DUPLICATE KEY UPDATE`，在 sqlite 上 `near "DUPLICATE": syntax error`。
 */
describe("dbAdapterUtil.adapterDialectOf", () => {
    it("better-sqlite3 适配器 ⇒ sqlite", () => {
        const db = new Database(":memory:");
        try {
            expect(adapterDialectOf(new SQLiteAdapter(db))).toBe("sqlite");
        } finally {
            db.close();
        }
    });

    it("D1 适配器 ⇒ sqlite（worker 与 D1 同用 sqlite 语法）", () => {
        expect(adapterDialectOf(new D1Adapter())).toBe("sqlite");
    });

    it("MySQL 适配器 ⇒ mysql（不依赖环境变量；未连库也能判定）", () => {
        expect(adapterDialectOf(new MySQLAdapter())).toBe("mysql");
    });
});
