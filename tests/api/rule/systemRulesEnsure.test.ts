import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import configService from "../../../src/service/configService";
import { SYSTEM_PLUGIN_RULES } from "../../../src/plugin/systemRules";

/**
 * `ensureSystemRules()`（`src/plugin/systemRulesSync.ts`）的行为用例 —— #382。
 *
 * 这里**不复制实现**：所有「生成/纠偏」动作都通过 `dbHelper.seedSystemRules()` 打到
 * 测试专用路由 `POST /test/ensure-system-rules`，由**服务进程里的生产代码**执行（那边 ORM 连着）。
 * 断言侧只用裸 SQL / 接口读回结果，避免「测试自己造了数据又自己断言」。
 *
 * 覆盖七件事：幂等、字段漂移纠正、enabled 不被改写、删后重建取配置默认值、
 * 老库升级（四条行已在、字段陈旧、开关被用户改过）、并发首建、规则表不可用时的硬失败。
 */

interface SystemRuleRow {
    id: number;
    type: string;
    name: string;
    scope: string;
    config: string;
    enabled: number;
    tenant_id: number;
    cross_tenant: number;
    priority: number;
    source: string;
    biz_id: string;
    note: string | null;
}

const RULE_COLUMNS = "id, type, name, scope, config, enabled, tenant_id, cross_tenant, priority, source, biz_id, note";

async function systemRows(): Promise<SystemRuleRow[]> {
    return await dbHelper.query<SystemRuleRow>(
        `SELECT ${RULE_COLUMNS} FROM rule WHERE source = 'system' ORDER BY priority ASC, id ASC`,
    );
}

async function rowByBizId(bizId: string): Promise<SystemRuleRow | undefined> {
    const rows = await dbHelper.query<SystemRuleRow>(`SELECT ${RULE_COLUMNS} FROM rule WHERE biz_id = '${bizId}'`);
    return rows[0];
}

/** 直接调用生产 ensure（经测试路由），返回 {created, updated, unchanged} */
async function ensure(): Promise<{ created: number; updated: number; unchanged: number }> {
    return await dbHelper.seedSystemRules();
}

describe("系统规则运行期生成（ensureSystemRules）", () => {
    /** 规则表 DDL 快照：最后一条用例会 DROP 表验硬失败，必须能还原 */
    let ruleTableDdl = "";

    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        const rows = await dbHelper.query<Record<string, string>>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rule'",
        ).catch(() => [] as Record<string, string>[]);
        if (rows.length > 0) {
            ruleTableDdl = String(rows[0].sql ?? "");
        } else {
            // MySQL 分支
            const created = await dbHelper.query<Record<string, string>>("SHOW CREATE TABLE rule");
            ruleTableDdl = String(created[0]?.["Create Table"] ?? "");
        }
        expect(ruleTableDdl.toLowerCase()).toContain("create table");
    }, 60000);

    beforeEach(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
    });

    afterAll(async () => {
        const rows = await dbHelper.query<Record<string, string>>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rule'",
        ).catch(() => [] as Record<string, string>[]);
        const exists = rows.length > 0
            || (await dbHelper.query<Record<string, string>>("SHOW TABLES LIKE 'rule'").catch(() => [])).length > 0;
        if (!exists && ruleTableDdl) {
            await dbHelper.execute(ruleTableDdl);
        }
    }, 60000);

    it("幂等：规则已齐时再跑一次是 created=0 / updated=0 / unchanged=4", async () => {
        // truncate() 已经重建过一次
        expect(await systemRows()).toHaveLength(SYSTEM_PLUGIN_RULES.length);

        const result = await ensure();

        expect(result).toEqual({ created: 0, updated: 0, unchanged: SYSTEM_PLUGIN_RULES.length });
        expect(await systemRows()).toHaveLength(SYSTEM_PLUGIN_RULES.length);
    });

    it("字段漂移会被纠正：name / priority / note / source 被手工改过后回到常量", async () => {
        const bizId = "SYS:setting:cch_rewrite";
        const before = await rowByBizId(bizId);
        expect(before).toBeDefined();

        await dbHelper.execute(
            `UPDATE rule SET name = '手工改名', priority = 999, note = '手工备注', source = 'user' WHERE biz_id = '${bizId}'`,
        );

        const result = await ensure();
        expect(result.updated + result.created).toBeGreaterThanOrEqual(1);

        const definition = SYSTEM_PLUGIN_RULES.find((item) => item.bizId === bizId)!;
        const after = await rowByBizId(bizId);
        expect(after?.name).toBe(definition.name);
        expect(after?.priority).toBe(definition.priority);
        expect(after?.note).toBe(definition.note);
        expect(after?.source).toBe("system");
        // enabled 不是漂移字段：这里没动过它，必须还等于原值
        expect(after?.enabled).toBe(before!.enabled);
    });

    it("enabled 永不被 ensure 改写（它是用户开关）", async () => {
        const bizId = "SYS:setting:responses_prompt_cache_key";
        await dbHelper.execute(`UPDATE rule SET enabled = 0 WHERE biz_id = '${bizId}'`);
        expect((await rowByBizId(bizId))?.enabled).toBe(0);

        const result = await ensure();

        expect(result.updated).toBe(0);
        expect((await rowByBizId(bizId))?.enabled).toBe(0);
    });

    it("行被删掉后重建：字段来自常量，enabled 取配置默认值（session_header 默认关）", async () => {
        const bizId = "SYS:setting:session_header";
        await dbHelper.execute(`DELETE FROM rule WHERE biz_id = '${bizId}'`);
        expect(await rowByBizId(bizId)).toBeUndefined();

        const result = await ensure();
        expect(result.created).toBe(1);

        const rebuilt = await rowByBizId(bizId);
        const definition = SYSTEM_PLUGIN_RULES.find((item) => item.bizId === bizId)!;
        expect(rebuilt?.name).toBe(definition.name);
        expect(rebuilt?.priority).toBe(definition.priority);
        expect(rebuilt?.cross_tenant).toBe(1);
        expect(rebuilt?.tenant_id).toBe(1);

        // 配置里没有该键 ⇒ 用后端默认值（session_header_enabled 默认 false）
        const configValues = await dbHelper.query<{ value: string }>(
            `SELECT value FROM config WHERE name = '${definition.configKey}'`,
        );
        const expected = configService.getConfigDefault(definition.configKey) !== "false"
            && configValues[0]?.value !== "false";
        expect(Boolean(rebuilt?.enabled)).toBe(expected);
        expect(Boolean(rebuilt?.enabled)).toBe(false);
    });

    it("老库升级模拟：四条行已在、字段陈旧、开关被用户改过 ⇒ 只纠字段、不动 enabled", async () => {
        // 造一个「迁移已跑过、但字段与常量不一致」的库：name/priority/note/scope/config 全陈旧
        const stale: Array<{ bizId: string; enabled: number }> = [
            { bizId: "SYS:setting:claudecode_tracking_rewrite", enabled: 0 },
            { bizId: "SYS:setting:cch_rewrite", enabled: 1 },
            { bizId: "SYS:setting:responses_prompt_cache_key", enabled: 0 },
            { bizId: "SYS:setting:session_header", enabled: 1 },
        ];
        for (const item of stale) {
            await dbHelper.execute(
                `UPDATE rule SET name = 'OLD-${item.bizId}', priority = 500, note = 'OLD',
                    scope = '{"type":"const","values":[false]}',
                    config = '{"plugin":"unknownPlugin","pluginConfig":{}}',
                    enabled = ${item.enabled}
                 WHERE biz_id = '${item.bizId}'`,
            );
        }

        const result = await ensure();

        expect(result.created).toBe(0);
        expect(result.updated).toBe(stale.length);
        for (const item of stale) {
            const definition = SYSTEM_PLUGIN_RULES.find((entry) => entry.bizId === item.bizId)!;
            const row = await rowByBizId(item.bizId);
            expect(row?.name).toBe(definition.name);
            expect(row?.priority).toBe(definition.priority);
            expect(row?.note).toBe(definition.note);
            expect(JSON.parse(row!.scope)).toEqual({ type: "const", values: [true] });
            expect(JSON.parse(row!.config)).toEqual({ plugin: definition.plugin, pluginConfig: definition.pluginConfig });
            // 用户开关原样保留
            expect(row?.enabled).toBe(item.enabled);
        }
    });

    it("并发首建：同时发起多次 ensure，只有一批真的插入，结果仍是 4 条", async () => {
        await dbHelper.execute("DELETE FROM rule WHERE source = 'system'");
        expect(await systemRows()).toHaveLength(0);

        const results = await Promise.all(Array.from({ length: 5 }, () => ensure()));

        const rows = await systemRows();
        expect(rows).toHaveLength(SYSTEM_PLUGIN_RULES.length);
        // 插进去的总数必须正好是 4 条：多插会撞唯一索引，少插说明有并发漏建
        expect(results.reduce((sum, item) => sum + item.created, 0)).toBe(SYSTEM_PLUGIN_RULES.length);
    });

    it("规则表不可用 ⇒ ensure 硬失败（不静默带病服务）", async () => {
        await dbHelper.execute("DROP TABLE rule");
        try {
            await expect(ensure()).rejects.toThrow(/ensure-system-rules|失败|no such table|doesn't exist/i);
        } finally {
            if (ruleTableDdl) {
                await dbHelper.execute(ruleTableDdl);
            }
        }
        // 还原自检：不是恒真断言 —— 真删掉了就必须真建回来且能写
        await dbHelper.seedSystemRules();
        expect(await systemRows()).toHaveLength(SYSTEM_PLUGIN_RULES.length);
    });
});
