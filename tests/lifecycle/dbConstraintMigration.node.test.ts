import { readFileSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const migrationDirectory = join(process.cwd(), "resource", "migrate");
let db: Database.Database | null = null;


/**
 * migrate_0030 之前的表结构：model 只对启用行唯一（部分索引）、client_config 只约束
 * "每 client 至多一个启用配置"（name 不参与唯一性）。与 1.8.6 的库状态一致。
 */
function createLegacySchema(database: Database.Database) {
    database.exec(`
        CREATE TABLE model (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            name   TEXT NOT NULL,
            enable BOOLEAN DEFAULT true NOT NULL
        );
        CREATE UNIQUE INDEX enabled_model_name_index ON model(name) WHERE enable = 1;

        CREATE TABLE client_config (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            client  TEXT NOT NULL,
            name    TEXT NOT NULL,
            enabled INTEGER DEFAULT 0 NOT NULL
        );
        CREATE INDEX client_config_client_index ON client_config (client);
        CREATE UNIQUE INDEX client_config_enabled_client_unique ON client_config (client) WHERE enabled = 1;

        CREATE TABLE vendor_model (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_id INTEGER NOT NULL,
            model_id  INTEGER NOT NULL
        );
        CREATE INDEX idx_vendor_model_vendor_id ON vendor_model (vendor_id);
    `);
}


function runMigration(name: string) {
    db!.exec(readFileSync(join(migrationDirectory, name, "sqlite.sql"), "utf8"));
}


afterEach(() => {
    db?.close();
    db = null;
});


describe("migrate_0030 在存量重名数据上建唯一索引", () => {
    it("同名模型：禁用的一条被改名，启用的一条保留原名", () => {
        db = new Database(":memory:");
        createLegacySchema(db);
        // 1.8.6 允许的存量数据：应用层只在启用时查重、DB 层只约束启用行
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(1, "gpt-4", 1);
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(2, "gpt-4", 0);
        // 启用的那条 id 更大：改名必须避开它，否则会改掉线上模型的名字
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(3, "claude", 0);
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(4, "claude", 1);
        // 全禁用时按 id 最小保留
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(5, "llama", 0);
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(6, "llama", 0);

        expect(() => runMigration("migrate_0030")).not.toThrow();

        expect(db.prepare("SELECT id, name FROM model ORDER BY id").all()).toEqual([
            { id: 1, name: "gpt-4" },
            { id: 2, name: "gpt-4-2" },
            { id: 3, name: "claude-3" },
            { id: 4, name: "claude" },
            { id: 5, name: "llama" },
            { id: 6, name: "llama-6" },
        ]);
    });

    it("同 client 同名备份：启用的一条保留原名", () => {
        db = new Database(":memory:");
        createLegacySchema(db);
        // 1.8.6 的 renameBackup 不查重，同名备份可达
        db.prepare(
            "INSERT INTO client_config (id, client, name, enabled) VALUES (?, ?, ?, ?)",
        ).run(1, "claude_code", "默认配置", 1);
        db.prepare(
            "INSERT INTO client_config (id, client, name, enabled) VALUES (?, ?, ?, ?)",
        ).run(2, "claude_code", "默认配置", 0);
        // 不同 client 的同名互不影响
        db.prepare(
            "INSERT INTO client_config (id, client, name, enabled) VALUES (?, ?, ?, ?)",
        ).run(3, "codex", "默认配置", 1);

        expect(() => runMigration("migrate_0030")).not.toThrow();

        expect(db.prepare("SELECT id, name FROM client_config ORDER BY id").all()).toEqual([
            { id: 1, name: "默认配置" },
            { id: 2, name: "默认配置-2" },
            { id: 3, name: "默认配置" },
        ]);
    });

    it("重构后的唯一索引真正生效", () => {
        db = new Database(":memory:");
        createLegacySchema(db);
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(1, "gpt-4", 1);
        db.prepare("INSERT INTO model (id, name, enable) VALUES (?, ?, ?)").run(2, "gpt-4", 0);

        runMigration("migrate_0030");

        // model.name 全局唯一：同名禁用模型也不再允许（跨租户唯一性由 migrate_0032 收回应用层）
        expect(() =>
            db!.prepare("INSERT INTO model (name, enable) VALUES (?, ?)").run("gpt-4", 0),
        ).toThrow(/UNIQUE/i);

        // 旧的条件索引已删除
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as
            { name: string }[];
        const names = indexes.map(index => index.name);
        expect(names).toContain("name_index");
        expect(names).toContain("client_config_client_name_unique");
        expect(names).not.toContain("enabled_model_name_index");
        expect(names).not.toContain("client_config_enabled_client_unique");
    });
});
