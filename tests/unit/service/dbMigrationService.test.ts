import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dbMigrationService from "../../../src/service/dbMigrationService";
import { SQLiteDBAdapter } from "../../../src/util/db/sqliteDBAdapter";

/**
 * 启动时的迁移策略与只读检查。
 *
 * check 是「不执行迁移、只比对记录」这条路径的全部依据，所以它必须严格只读：
 * 空库上不能顺手把 _migrations 表建出来（那已经算修改数据库了）。
 */
describe("dbMigrationService.check", () => {
    let tmpDir: string | null = null;

    function openTempDb(): { adapter: SQLiteDBAdapter } {
        tmpDir = mkdtempSync(join(tmpdir(), "gt-migrate-"));
        return { adapter: new SQLiteDBAdapter(join(tmpDir, "empty.db")) };
    }

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
            tmpDir = null;
        }
    });

    it("reports every migration as pending on an empty database, without writing to it", async () => {
        const { adapter } = openTempDb();

        const { applied, pending } = await dbMigrationService.check(adapter);

        expect(applied).toEqual([]);
        expect(pending.length).toBeGreaterThan(0);

        // 只读：空库上不会因为检查而多出 _migrations 表
        const tables = (await adapter.query("SELECT name FROM sqlite_master WHERE type='table'")) as Array<{ name: string }>;
        expect(tables.map((t) => t.name)).not.toContain("_migrations");

        adapter.close();
    });

    it("reports nothing pending once the migrations have been applied", async () => {
        const { adapter } = openTempDb();

        await dbMigrationService.migrate(adapter, "test");
        const { pending } = await dbMigrationService.check(adapter);

        expect(pending).toEqual([]);

        adapter.close();
    });
});


/**
 * clear 按白名单删表（不再"列出所有表再排除"），代价是新增迁移时必须同步补白名单，
 * 否则新表会躲过 clear。这两条用例把那件事变成会红的测试。
 */
describe("dbMigrationService.DROPPABLE_TABLES", () => {
    let tmpDir: string | null = null;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
            tmpDir = null;
        }
    });

    it("covers every table the migrations create", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "gt-migrate-"));
        const adapter = new SQLiteDBAdapter(join(tmpDir, "migrated.db"));
        await dbMigrationService.migrate(adapter, "test");

        const rows = (await adapter.query(
            "SELECT name FROM sqlite_master WHERE type='table'",
        )) as Array<{ name: string }>;
        const createdTables = rows
            .map((row) => row.name)
            .filter((name) => !name.startsWith("sqlite_"));   // sqlite_sequence 之类的系统表

        const whitelist = new Set(dbMigrationService.DROPPABLE_TABLES);
        expect(createdTables.filter((name) => !whitelist.has(name))).toEqual([]);

        adapter.close();
    });

    it("drops the migration records too, so a cleared database is a blank slate", () => {
        expect(dbMigrationService.DROPPABLE_TABLES).toContain("_migrations");
    });
});


describe("dbMigrationService.getMigrationMode", () => {
    const original = process.env.MIGRATION_MODE;

    afterEach(() => {
        if (original === undefined) {
            delete process.env.MIGRATION_MODE;
        } else {
            process.env.MIGRATION_MODE = original;
        }
    });

    it("defaults to execute", () => {
        delete process.env.MIGRATION_MODE;

        expect(dbMigrationService.getMigrationMode()).toBe("execute");
    });

    it("accepts the three values, ignoring case and surrounding spaces", () => {
        for (const value of ["execute", "check", "off", "CHECK", " off "]) {
            process.env.MIGRATION_MODE = value;
            expect(dbMigrationService.getMigrationMode()).toBe(value.trim().toLowerCase());
        }
    });

    it("rejects an unknown value instead of falling back to execute", () => {
        process.env.MIGRATION_MODE = "checks";

        expect(() => dbMigrationService.getMigrationMode()).toThrow(/Invalid MIGRATION_MODE/);
    });
});
