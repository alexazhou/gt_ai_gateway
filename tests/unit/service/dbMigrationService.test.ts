import { afterEach, describe, expect, it } from "vitest";
import dbMigrationService from "../../../src/service/dbMigrationService";
import {
    createMigrationTestDb,
    listTables,
    type MigrationTestDb,
} from "../../helpers/migrationTestDb";

/**
 * 启动时的迁移策略与只读检查。
 *
 * check 是「不执行迁移、只比对记录」这条路径的全部依据，所以它必须严格只读：
 * 空库上不能顺手把 _migrations 表建出来（那已经算修改数据库了）。
 */
describe("dbMigrationService.check", () => {
    let db: MigrationTestDb | null = null;

    afterEach(async () => {
        await db?.close();
        db = null;
    });

    it("reports every migration as pending on an empty database, without writing to it", async () => {
        db = await createMigrationTestDb();

        const { applied, pending } = await dbMigrationService.check(db.adapter);

        expect(applied).toEqual([]);
        expect(pending.length).toBeGreaterThan(0);

        // 只读：空库上不会因为检查而多出 _migrations 表
        expect(await listTables(db.adapter)).not.toContain("_migrations");
    });

    it("reports nothing pending once the migrations have been applied", async () => {
        db = await createMigrationTestDb();

        await dbMigrationService.migrate(db.adapter, "test");
        const { pending } = await dbMigrationService.check(db.adapter);

        expect(pending).toEqual([]);
    });
});


/**
 * clear 按白名单删表（不再"列出所有表再排除"），代价是新增迁移时必须同步补白名单，
 * 否则新表会躲过 clear。这两条用例把那件事变成会红的测试。
 */
describe("dbMigrationService.DROPPABLE_TABLES", () => {
    let db: MigrationTestDb | null = null;

    afterEach(async () => {
        await db?.close();
        db = null;
    });

    it("covers every table the migrations create", async () => {
        db = await createMigrationTestDb();
        await dbMigrationService.migrate(db.adapter, "test");

        // sqlite_sequence 之类是数据库自己的表，不算业务表
        const createdTables = (await listTables(db.adapter))
            .filter((name) => !name.startsWith("sqlite_"));

        const whitelist = new Set(dbMigrationService.DROPPABLE_TABLES);
        expect(createdTables.filter((name) => !whitelist.has(name))).toEqual([]);
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
