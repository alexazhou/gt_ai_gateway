import { readFileSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RULE_SOURCE, SYSTEM_PLUGIN_RULES } from "../../src/plugin/systemRules";

/**
 * migrate_0035（通用请求插件规则化 v3）的数据迁移行为。
 *
 * 直接在**迁移前的库结构**上跑迁移 SQL（不走 runner），这样能构造 runner 不会遇到、
 * 但线上一定存在的历史数据形态：存量限流规则、两个 tracking 键并存、config 行缺失。
 */
const migrationDirectory = join(process.cwd(), "resource", "migrate");
const sqliteMigrationSql = readFileSync(join(migrationDirectory, "migrate_0035", "sqlite.sql"), "utf8");

let db: Database.Database | null = null;

afterEach(() => {
    db?.close();
    db = null;
});

/** 迁移前的库结构（migrate_0031 的 rule + migrate_0032 的 tenant/tenant_id/cross_tenant + migrate_0017 的 config） */
function createLegacySchema(): Database.Database {
    const database = new Database(":memory:");
    database.exec(`
        CREATE TABLE tenant (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NULL
        );
        CREATE UNIQUE INDEX tenant_name_index ON tenant (name);

        CREATE TABLE config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            value TEXT NOT NULL
        );
        CREATE UNIQUE INDEX config_name_index ON config (name);

        CREATE TABLE rule (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            scope TEXT NOT NULL,
            config TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            tenant_id BIGINT NULL,
            cross_tenant TINYINT(1) NOT NULL DEFAULT 0
        );
    `);
    database.exec("INSERT INTO tenant (id, name, description) VALUES (1, 'main', '主租户'), (2, 'acme', '普通租户')");
    return database;
}

interface RuleRow {
    id: number;
    type: string;
    name: string;
    scope: string;
    config: string;
    enabled: number;
    tenant_id: number | null;
    cross_tenant: number;
    priority: number;
    source: string;
    biz_id: string | null;
}

function allRules(database: Database.Database): RuleRow[] {
    return database.prepare(
        "SELECT id, type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id FROM rule ORDER BY priority ASC, id ASC",
    ).all() as RuleRow[];
}

function configValue(database: Database.Database, name: string): string | undefined {
    const row = database.prepare("SELECT value FROM config WHERE name = ?").get(name) as { value: string } | undefined;
    return row?.value;
}

describe("migrate_0035（通用请求插件规则化）", () => {
    it("存量规则回填 priority=100 / source=user / biz_id=NULL，类型与配置不受影响", () => {
        db = createLegacySchema();
        db.exec(`
            INSERT INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant)
            VALUES ('rate_limit', 'legacy-rpm', '{"type":"const","values":[true]}', '{"rpm":10}', 1, 1, 0);
            INSERT INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant)
            VALUES ('forbid_access', 'legacy-deny', '{"type":"const","values":[true]}', '{}', 0, 2, 0);
        `);

        db.exec(sqliteMigrationSql);

        // 只看存量（用户）规则：三条系统规则是迁移新插入的，另有用例覆盖
        const legacy = allRules(db).filter((rule) => rule.source === RULE_SOURCE.USER);
        expect(legacy).toHaveLength(2);
        for (const rule of legacy) {
            expect(rule.priority).toBe(100);
            expect(rule.source).toBe(RULE_SOURCE.USER);
            expect(rule.biz_id).toBeNull();
        }
        expect(legacy.map((rule) => rule.type)).toEqual(["rate_limit", "forbid_access"]);
        expect(JSON.parse(legacy[0].config)).toEqual({ rpm: 10 });
        expect(legacy[1].enabled).toBe(0);
    });

    it("旧 tracking 键并入新键：以旧键值为准，旧键删除", () => {
        db = createLegacySchema();
        // 新旧两键并存且值相反 —— 旧前端最后一次保存的状态在旧键里，必须赢
        db.exec(`
            INSERT INTO config (name, value) VALUES ('claude_code_tracking_rewrite_enabled', 'false');
            INSERT INTO config (name, value) VALUES ('claudecode_tracking_rewrite_enabled', 'true');
        `);

        db.exec(sqliteMigrationSql);

        expect(configValue(db, "claude_code_tracking_rewrite_enabled")).toBeUndefined();
        expect(configValue(db, "claudecode_tracking_rewrite_enabled")).toBe("false");
    });

    it("只有旧键时直接搬过来（新键原本不存在）", () => {
        db = createLegacySchema();
        db.exec("INSERT INTO config (name, value) VALUES ('claude_code_tracking_rewrite_enabled', 'false');");

        db.exec(sqliteMigrationSql);

        expect(configValue(db, "claude_code_tracking_rewrite_enabled")).toBeUndefined();
        expect(configValue(db, "claudecode_tracking_rewrite_enabled")).toBe("false");
    });

    it("预置的三条系统规则与 SYSTEM_PLUGIN_RULES 逐字段一致（防迁移 SQL 与 TS 常量漂移）", () => {
        db = createLegacySchema();
        db.exec(sqliteMigrationSql);

        const systemRules = allRules(db);
        expect(systemRules).toHaveLength(SYSTEM_PLUGIN_RULES.length);

        SYSTEM_PLUGIN_RULES.forEach((definition, index) => {
            const row = systemRules[index];
            expect(row.biz_id).toBe(definition.bizId);
            expect(row.name).toBe(definition.name);
            expect(row.priority).toBe(definition.priority);
            expect(row.type).toBe("plugin");
            expect(row.source).toBe(RULE_SOURCE.SYSTEM);
            // 系统规则是 main 租户下的全局共享规则
            expect(row.tenant_id).toBe(1);
            expect(row.cross_tenant).toBe(1);
            expect(JSON.parse(row.scope)).toEqual({ type: "const", values: [true] });
            expect(JSON.parse(row.config)).toEqual({ plugin: definition.plugin, pluginConfig: definition.pluginConfig });
        });
        // 优先级顺序就是执行顺序
        expect(systemRules.map((rule) => rule.priority)).toEqual([10, 20, 30]);
    });

    it("系统规则 enabled 跟随迁移后可读到的配置值（有行用行值，无行用默认 true）", () => {
        db = createLegacySchema();
        db.exec(`
            INSERT INTO config (name, value) VALUES ('cch_rewrite_enabled', 'false');
            INSERT INTO config (name, value) VALUES ('responses_prompt_cache_key_enabled', 'true');
            -- claudecode_tracking_rewrite_enabled 无行 → 按后端默认 true
        `);

        db.exec(sqliteMigrationSql);

        const byBizId = new Map(allRules(db).map((rule) => [rule.biz_id, rule]));
        expect(byBizId.get("SYS:setting:claudecode_tracking_rewrite")?.enabled).toBe(1);
        expect(byBizId.get("SYS:setting:cch_rewrite")?.enabled).toBe(0);
        expect(byBizId.get("SYS:setting:responses_prompt_cache_key")?.enabled).toBe(1);
    });

    it("旧键存在且为 false 时，对应的系统规则就是关闭的（不是「行存在就当 true」）", () => {
        db = createLegacySchema();
        db.exec("INSERT INTO config (name, value) VALUES ('claude_code_tracking_rewrite_enabled', 'false');");

        db.exec(sqliteMigrationSql);

        const tracking = allRules(db).find((rule) => rule.biz_id === "SYS:setting:claudecode_tracking_rewrite");
        expect(tracking?.enabled).toBe(0);
    });

    it("主租户缺失时不预置系统规则，但加列与索引照常完成", () => {
        db = createLegacySchema();
        db.exec("DELETE FROM tenant WHERE name = 'main'");

        db.exec(sqliteMigrationSql);

        expect(allRules(db)).toHaveLength(0);
        const columns = (db.prepare("PRAGMA table_info(rule)").all() as { name: string }[]).map((column) => column.name);
        expect(columns).toEqual(expect.arrayContaining(["priority", "source", "biz_id"]));
    });

    it("biz_id 唯一约束生效，用户规则可以有多个 NULL", () => {
        db = createLegacySchema();
        db.exec(sqliteMigrationSql);

        db.exec(`
            INSERT INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant)
            VALUES ('rate_limit', 'a', '{"type":"const","values":[true]}', '{"rpm":1}', 1, 1, 0);
            INSERT INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant)
            VALUES ('rate_limit', 'b', '{"type":"const","values":[true]}', '{"rpm":2}', 1, 1, 0);
        `);

        expect(() => db!.exec(`
            INSERT INTO rule (type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id)
            VALUES ('plugin', 'dup', '{"type":"const","values":[true]}', '{"plugin":"cchRewriter","pluginConfig":{}}', 1, 1, 0, 100, 'system', 'SYS:setting:cch_rewrite');
        `)).toThrow(/UNIQUE/i);

        // 用户规则的 biz_id 为 NULL，可以共存任意多条
        expect(allRules(db).filter((rule) => rule.biz_id === null)).toHaveLength(2);
    });
});
