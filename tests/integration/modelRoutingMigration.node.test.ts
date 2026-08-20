import { readFileSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const migrationDirectory = join(process.cwd(), "resource", "migrate");
let db: Database.Database | null = null;


afterEach(() => {
    db?.close();
    db = null;
});


describe("model multi-upstream migration", () => {
    it("converts legacy model upstream fields into routing configuration in one migration", () => {
        db = new Database(":memory:");
        db.exec(`
            CREATE TABLE model (
                id INTEGER PRIMARY KEY,
                name TEXT,
                vendor_id INTEGER,
                vendor_model_id INTEGER
            );
            CREATE TABLE vendor_model (
                id INTEGER PRIMARY KEY,
                vendor_id INTEGER,
                model_id TEXT
            );
        `);
        db.prepare(
            "INSERT INTO model (id, name, vendor_id, vendor_model_id) VALUES (?, ?, ?, ?)",
        ).run(1, "legacy-model", 3, 7);
        db.prepare(
            "INSERT INTO model (id, name, vendor_id, vendor_model_id) VALUES (?, ?, ?, ?)",
        ).run(2, "unconfigured-model", null, null);
        db.prepare(
            "INSERT INTO vendor_model (id, vendor_id, model_id) VALUES (?, ?, ?)",
        ).run(7, 3, "legacy-upstream-model");

        db.exec(readFileSync(join(migrationDirectory, "migrate_0026", "sqlite.sql"), "utf8"));

        const migrated = db.prepare(
            "SELECT routing_mode, routing_config FROM model WHERE id = ?",
        ).get(1) as { routing_mode: string; routing_config: string };
        const unconfigured = db.prepare(
            "SELECT routing_mode, routing_config FROM model WHERE id = ?",
        ).get(2) as { routing_mode: string; routing_config: string };

        // 存量 model 显式写成 single 上游（不依赖列默认值）
        expect(migrated.routing_mode).toBe("single");
        expect(JSON.parse(migrated.routing_config)).toEqual({
            upstreams: [{ vendor_id: 3, vendor_model_id: 7, enabled: true }],
            failover: { enabled: true },
        });
        // 未配置上游的 model 两列缺省均为 NULL，由代码兜底
        expect(unconfigured.routing_mode).toBeNull();
        expect(unconfigured.routing_config).toBeNull();

        // 顶层 vendor 字段已被删除
        const modelColumns = db.prepare("PRAGMA table_info(model)").all() as Array<{ name: string }>;
        expect(modelColumns.map(column => column.name)).not.toContain("vendor_id");
        expect(modelColumns.map(column => column.name)).not.toContain("vendor_model_id");
        expect(modelColumns.map(column => column.name)).toEqual(expect.arrayContaining([
            "routing_mode",
            "routing_config",
        ]));

        // 健康状态已移到进程内存，vendor_model 表不再有 health 列
        const vendorModelColumns = db.prepare("PRAGMA table_info(vendor_model)").all() as Array<{ name: string }>;
        expect(vendorModelColumns.map(column => column.name)).not.toContain("health");
    });
});
