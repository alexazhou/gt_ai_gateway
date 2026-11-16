import { afterEach, describe, expect, it, vi } from "vitest";
import dbMigrationService from "../../src/service/dbMigrationService";
import {
    createMigrationTestDb,
    listTables,
    type MigrationTestDb,
} from "../helpers/migrationTestDb";

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


/**
 * 反向差异：库里已应用、而迁移目录里已经不存在那条迁移。
 *
 * **这不是期望语义，是当前实现的已知盲区**（#287 验收时发现，任务 #288 补测）。
 * `readMigrationState()` 的判据只有这一个方向：
 *
 *     pending = available.filter(name => !appliedNames.has(name))
 *
 * 「目录里有、库里没有」⇒ 进 pending，会被执行；
 * 反过来「库里有、目录没有」既不进 pending，也不产生任何告警，更没有清理动作：
 * `migrate()` 会打印 `Database is up to date`，`status()` 的 Current Database Version
 * 还会被那条孤儿记录顶高，它当初建的表也照旧留在库头。
 *
 * 现实版本：`migrate_0033` 曾在 #287（验收对象 `b6f1c34`）随「撤销限流与上游冷却表」
 * 被整目录删掉，早先跑过它的库就停在 `Applied 33 / Available 32` —— 不报错、不自愈。
 * 随后 #289（`3b8db94`）把口径改回「历史只增不改」：`migrate_0033` 目录与 `_migrations`
 * 记录都保留，另起 `migrate_0034` 用 `DROP TABLE IF EXISTS` 清掉它建的两张表。
 * 这就是本仓对这类反向差异的收敛写法：**追加新编号的反向迁移去清对象，绝不删除迁移记录**。
 *
 * 本用例把这个「沉默」钉成已知事实，防止有人无意改动判据：谁要把这里改成
 * 「记录缺失即报错 / 自动清理」，这里会红，请同步更新本用例并在提交信息里写明
 * 迁移收敛策略（参照 `migrate_0034`：新编号迁移 DROP 残留对象，**不要** DELETE
 * `_migrations` 记录），不要让它悄悄变绿。
 */
describe("dbMigrationService 反向差异（库里有记录、目录里没有该迁移）", () => {
    let db: MigrationTestDb | null = null;

    afterEach(async () => {
        await db?.close();
        db = null;
    });

    it("沉默跳过：migrate() 不报错、pending 为空、状态版本号反映孤儿记录、残留表仍在", async () => {
        db = await createMigrationTestDb();
        await dbMigrationService.migrate(db.adapter, "test");

        // 前置：全部迁移已应用，没有任何待应用
        const before = await dbMigrationService.check(db.adapter);
        expect(before.pending).toEqual([]);
        expect(before.applied.length).toBeGreaterThan(0);

        // 造反向差异：一条目录里根本不存在的迁移记录 + 它当初建的那张表。
        // 编号故意用 9999 这种绝不会存在的值：0033 是**保留的历史迁移**（它建的两张表
        // 由 0034 清掉，下一个可用编号是 0035），拿它当「孤儿」会让人误读成本用例的结论。
        const ORPHAN = "migrate_9999";
        await db.adapter.run(
            `INSERT INTO _migrations (name, applied_at) VALUES ('${ORPHAN}', '2026-01-01 00:00:00')`,
        );
        await db.adapter.run("CREATE TABLE IF NOT EXISTS orphan_leftover_table (id INTEGER PRIMARY KEY)");

        // ① migrate() 撞上孤儿记录不抛错 —— 这就是「沉默」
        let thrown: unknown = null;
        try {
            await dbMigrationService.migrate(db.adapter, "test");
        } catch (e) {
            thrown = e;
        }
        expect(thrown, "孤儿记录不应让 migrate() 抛错（当前实现是沉默跳过）").toBeNull();

        // ② 判据看不见反方向：pending 仍为空，孤儿记录原样留在 _migrations 里、没被清理
        const after = await dbMigrationService.check(db.adapter);
        expect(after.pending).toEqual([]);
        expect(after.applied).toContain(ORPHAN);
        expect(after.applied.length, "孤儿记录不会被自动清理").toBe(before.applied.length + 1);

        // ③ status() 的版本号被孤儿记录顶高（9999 > 目录里最大编号），且待应用数仍是 0
        const logged: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            logged.push(args.map((a) => String(a)).join(" "));
        });
        try {
            await dbMigrationService.status(db.adapter);
        } finally {
            spy.mockRestore();
        }
        const output = logged.join("\n");
        expect(output).toContain("Current Database Version: 9999");
        expect(output).toContain("Migrations to apply: 0");

        // ④ 残留表现状仍在：没有任何清理动作
        expect(await listTables(db.adapter)).toContain("orphan_leftover_table");
    });
});


/**
 * 收敛：装过 v1.9.1-beta1 的老库，一次 `migrate()` 就能到当前终态。
 *
 * 老库形状：`_migrations` 停在 `migrate_0033`（0033 建的那两张表还在库头），而迁移目录里
 * 多了一条 `migrate_0034`（#289，`3b8db94`）—— 它只 `DROP` 那两张表，**不动迁移历史**。
 *
 * 复现方式（不依赖真实老库、不碰 `local.db`）：干净库上跑完全部迁移 → 把 0033 的两张表
 * 建回来 → `DELETE` 掉 0034 那条记录，就得到「停在 0033」的形状。
 * 注意这是**复现老库**的手法，不是收敛手段：收敛只允许 `migrate_0034` 那种
 * 「新编号迁移 DROP 对象」，`DELETE FROM _migrations` 属于改写历史，明文禁止。
 *
 * 断言按 Operator 2026-11-16 23:10 的新口径：两表消失、**0033 记录保留**、0034 记录在、
 * `pending` 为空、`status()` 版本 34。若有人把 0034 改成删 0033 记录，本用例会红。
 */
describe("dbMigrationService 收敛：装过 v1.9.1-beta1 的老库（migrate_0034）", () => {
    let db: MigrationTestDb | null = null;

    afterEach(async () => {
        await db?.close();
        db = null;
    });

    it("老库跑一次 migrate()：两表消失、0033 记录保留、0034 记录写入、版本 34", async () => {
        db = await createMigrationTestDb();
        await dbMigrationService.migrate(db.adapter, "test");

        // 造「装过 beta1」的老库形状。两张表只为占位：断言看的是表名存在性，schema 与本用例无关。
        await db.adapter.run("CREATE TABLE IF NOT EXISTS rate_limit_bucket (id INTEGER PRIMARY KEY)");
        await db.adapter.run("CREATE TABLE IF NOT EXISTS upstream_health (id INTEGER PRIMARY KEY)");
        await db.adapter.run("DELETE FROM _migrations WHERE name = 'migrate_0034'");

        // 前置：库里停在 0033，唯一待应用的就是 0034
        const before = await dbMigrationService.check(db.adapter);
        expect(before.applied).toContain("migrate_0033");
        expect(before.applied).not.toContain("migrate_0034");
        expect(before.pending).toEqual(["migrate_0034"]);
        const tablesBefore = await listTables(db.adapter);
        expect(tablesBefore).toContain("rate_limit_bucket");
        expect(tablesBefore).toContain("upstream_health");

        // 收敛：跑一次 migrate()，它应当只带上 0034
        const migrated: string[] = [];
        const migrateSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            migrated.push(args.map((a) => String(a)).join(" "));
        });
        try {
            await dbMigrationService.migrate(db.adapter, "test");
        } finally {
            migrateSpy.mockRestore();
        }
        expect(migrated.join("\n")).toContain("Pending: 1");

        // ① 0033 建的两张表被 0034 清掉
        const tablesAfter = await listTables(db.adapter);
        expect(tablesAfter, "migrate_0034 应 DROP 掉 0033 的 rate_limit_bucket").not.toContain(
            "rate_limit_bucket",
        );
        expect(tablesAfter, "migrate_0034 应 DROP 掉 0033 的 upstream_health").not.toContain(
            "upstream_health",
        );

        // ② 迁移历史只增不改：0033 记录仍在，0034 记录写入，待应用清空
        const after = await dbMigrationService.check(db.adapter);
        expect(after.applied, "0033 是历史迁移，记录不许删").toContain("migrate_0033");
        expect(after.applied, "0034 应被 runner 记进 _migrations").toContain("migrate_0034");
        expect(after.applied.length, "只多出 0034 一条记录").toBe(before.applied.length + 1);
        expect(after.pending).toEqual([]);

        // ③ status() 版本 = 34、待应用 0
        const statusLogs: string[] = [];
        const statusSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            statusLogs.push(args.map((a) => String(a)).join(" "));
        });
        try {
            await dbMigrationService.status(db.adapter);
        } finally {
            statusSpy.mockRestore();
        }
        const statusOut = statusLogs.join("\n");
        expect(statusOut).toContain("Current Database Version: 34");
        expect(statusOut).toContain("Migrations to apply: 0");
    });
});
