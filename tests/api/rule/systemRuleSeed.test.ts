import { beforeEach, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import userFixtures from "../../fixtures/userFixtures";
import { SYSTEM_PLUGIN_RULES } from "../../../src/plugin/systemRules";

/**
 * 测试基座的承重不变量：**清表后三条系统规则必须被重建，且 `enabled` 取自配置现值**。
 *
 * 为什么单独立一个文件钉这条（T7 / #354）：
 * - 系统规则是请求期插件是否执行的唯一真源；`dbHelper.truncate()` 清空 rule 表后若不重建，
 *   「没有规则 = 不执行」是正常路径，全量测试**照样绿**，但三个内置插件已静默失效；
 * - 所以这条不变量必须由一个**会变红的用例**守着：把 `truncate()` 里的 `seedSystemRules()`
 *   调用去掉后，本文件必须红（T7 的 R1 变异证明就是这样跑的）；
 * - 同时钉住 `enabled` 的来源：不是写死 true，而是「清表后运行期能读到的配置值」，
 *   否则 `cch_rewrite_enabled`（migrate_0017 预置为 'false'）在测试库和真库上会不一致。
 */
const adminToken = userFixtures.ADMIN_TOKEN;

async function systemRules(): Promise<any[]> {
    const response = await requestHelper.get("/rule/list.json?source=system", adminToken);
    expect(response.status).toBe(200);
    return response.body.list as any[];
}

async function ruleByBizId(bizId: string): Promise<any | undefined> {
    return (await systemRules()).find((rule) => rule.biz_id === bizId);
}

async function putConfig(body: Record<string, string>) {
    return await requestHelper.put("/config.json", body, adminToken);
}

describe("清表后的系统规则重建（测试基座不变量）", () => {
    beforeEach(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
    });

    it("三条系统规则都在，且 enabled / priority / source 与定义及配置现值一致", async () => {
        const config = await requestHelper.get("/config.json", adminToken);
        expect(config.status).toBe(200);

        const rules = await systemRules();
        expect(rules).toHaveLength(SYSTEM_PLUGIN_RULES.length);

        for (const definition of SYSTEM_PLUGIN_RULES) {
            const rule = rules.find((item) => item.biz_id === definition.bizId);
            expect(rule, `系统规则 ${definition.bizId} 在清表后不存在`).toBeDefined();
            expect(rule.name).toBe(definition.name);
            expect(rule.source).toBe("system");
            expect(rule.priority).toBe(definition.priority);
            expect(rule.config.plugin).toBe(definition.plugin);

            // enabled 必须等于「配置里当前能读到的值」（缺省按 CONFIG_DEFAULTS）
            const raw = config.body[definition.configKey];
            const expected = String(raw ?? "true") !== "false";
            expect(
                rule.enabled,
                `${definition.bizId} 的 enabled 应等于配置 ${definition.configKey}=${String(raw)}`,
            ).toBe(expected);
        }
    });

    it("重建时 enabled 取自配置现值，而不是写死 true", async () => {
        // 先把 cch 开关改成 false（写配置 + 同步已有系统规则）
        const response = await putConfig({ cch_rewrite_enabled: "false" });
        expect(response.status).toBe(200);

        // 模拟「规则表丢了、配置还在」：删掉三条系统规则后重新播种
        await dbHelper.execute("DELETE FROM rule WHERE source = 'system'");
        expect(await systemRules()).toHaveLength(0);

        await dbHelper.seedSystemRules();

        const rebuilt = await ruleByBizId("SYS:setting:cch_rewrite");
        expect(rebuilt, "重新播种后 cch 规则缺失").toBeDefined();
        expect(rebuilt.enabled).toBe(false);

        // 其它两条仍是启用（它们的开关没被改过）
        expect((await ruleByBizId("SYS:setting:claudecode_tracking_rewrite")).enabled).toBe(true);
        expect((await ruleByBizId("SYS:setting:responses_prompt_cache_key")).enabled).toBe(true);
    });
});
