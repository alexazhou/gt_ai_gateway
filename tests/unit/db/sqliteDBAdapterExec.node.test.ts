import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDBAdapter } from "../../../src/util/db/sqliteDBAdapter";

/**
 * P1-11 验收门：迁移 SQL 里的 `;` 不能被切半。
 *
 * 修复前 `exec()` 先 `sql.split(";")` 逐条执行，只有抛错才回退到整段 `db.exec`：
 * - `DEFAULT ';'`（字符串字面量里的分号）会被切在中间，单条执行必然语法错误；
 * - `CREATE TRIGGER ... BEGIN ... END;` 的触发器体内部全是分号，切完整段都不成立；
 * 回退路径不但掩盖真实错误，还把错误定位到「某条被切碎的片段」上。
 *
 * 修复后直接交给 better-sqlite3 的 exec（内部 sqlite3_exec，原生支持多语句）。
 * 用例把三类「分号陷阱」放进同一段迁移 SQL，一次执行验证。
 */

const MIGRATION_WITH_SEMICOLONS = `
-- 注释里也可以有分号; 这一行以前会被切碎
CREATE TABLE sep_test (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sep TEXT NOT NULL DEFAULT ';',
    label TEXT
);

CREATE TABLE sep_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sep_id INTEGER,
    note TEXT
);

CREATE TRIGGER sep_test_audit AFTER INSERT ON sep_test
BEGIN
    INSERT INTO sep_audit (sep_id, note) VALUES (NEW.id, 'inserted: ' || COALESCE(NEW.label, ''));
    UPDATE sep_audit SET note = note || ';' WHERE sep_id = NEW.id;
END;
`;

let tempDir: string | null = null;
let adapter: SQLiteDBAdapter | null = null;

function createAdapter(): SQLiteDBAdapter {
    tempDir = mkdtempSync(join(tmpdir(), "gwa-sep-"));
    adapter = new SQLiteDBAdapter(join(tempDir, "sep.db"));
    return adapter;
}

afterEach(async () => {
    if (adapter) {
        await adapter.close();
        adapter = null;
    }
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

describe("P1-11 SQLiteDBAdapter.exec 支持含分号的多语句脚本", () => {
    it("DEFAULT ';' / 注释里的分号 / BEGIN...END 触发器能一次性执行成功", () => {
        const db = createAdapter();

        expect(() => db.exec(MIGRATION_WITH_SEMICOLONS)).not.toThrow();
    });

    it("DEFAULT 值真的是一个分号（没被切成空串或半截）", async () => {
        const db = createAdapter();
        await db.exec(MIGRATION_WITH_SEMICOLONS);

        const ddl = await db.query<any>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sep_test'",
        );
        expect(String(ddl[0]?.sql)).toContain("DEFAULT ';'");

        // 实际插入一行取默认值
        await db.run("INSERT INTO sep_test (label) VALUES (?)", "a");
        const rows = await db.query<any>("SELECT sep FROM sep_test WHERE label = 'a'");
        expect(rows).toHaveLength(1);
        expect(rows[0].sep).toBe(";");
    });

    it("触发器体完整安装并真的生效（BEGIN...END 里的多条语句都在）", async () => {
        const db = createAdapter();
        await db.exec(MIGRATION_WITH_SEMICOLONS);

        await db.run("INSERT INTO sep_test (label) VALUES (?)", "hello");

        const audits = await db.query<any>("SELECT sep_id, note FROM sep_audit");
        expect(audits).toHaveLength(1);
        expect(Number(audits[0].sep_id)).toBe(1);
        // 两条语句都执行了：先写入 'inserted: hello'，再追加 ';'
        expect(String(audits[0].note)).toBe("inserted: hello;");
    });

    it("多语句里最后一条没有分号也能执行（迁移脚本常见写法）", async () => {
        const db = createAdapter();

        expect(() =>
            db.exec("CREATE TABLE tail_test (id INTEGER PRIMARY KEY); INSERT INTO tail_test (id) VALUES (1)"),
        ).not.toThrow();

        const rows = await db.query<any>("SELECT id FROM tail_test");
        expect(rows).toHaveLength(1);
    });

    it("真正的语法错误仍然抛错（不要为了「容错」把错误吞掉）", async () => {
        const db = createAdapter();
        await db.exec("CREATE TABLE ok_table (id INTEGER PRIMARY KEY);");

        expect(() => db.exec("THIS IS NOT SQL;")).toThrow();
    });
});
