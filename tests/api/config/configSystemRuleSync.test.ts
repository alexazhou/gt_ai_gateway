import { beforeEach, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import userFixtures from "../../fixtures/userFixtures";
import { SYSTEM_PLUGIN_RULES } from "../../../src/plugin/systemRules";

/**
 * 高级设置开关 ↔ 系统规则联动（T4，design/2026-11-24-generic-plugin step2_technical.md §3.2）。
 *
 * 口径是「写联动、读归口」：开关是唯一写入口，规则是运行期唯一真源。
 * 因此这里断言的是**写完之后规则状态真的变了**，而不是只看配置表。
 *
 * 三条边界也在用例里钉住：
 * - 旧键名（老前端提交的 tracking 键）仍能写，且落到新键 + 同步规则；
 * - 系统规则缺失时**报错不自动补齐**，且配置不被写坏（先查规则再写配置）；
 * - 同步只动 `enabled`，规则的名字/优先级/参数不可由配置侧篡改。
 */
const adminToken = userFixtures.ADMIN_TOKEN;

async function systemRules() {
    const response = await requestHelper.get("/rule/list.json?source=system", adminToken);
    expect(response.status).toBe(200);
    return response.body.list as any[];
}

async function ruleByBizId(bizId: string) {
    const rules = await systemRules();
    return rules.find((rule) => rule.biz_id === bizId);
}

async function putConfig(body: Record<string, string>) {
    return await requestHelper.put("/config.json", body, adminToken);
}

describe("高级设置开关与系统规则联动", () => {
    beforeEach(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
    });

    it("关闭「强制改写 CCH」：配置落库，对应系统规则 enabled 同步为 false，其它规则不受影响", async () => {
        const before = await systemRules();
        expect(before).toHaveLength(SYSTEM_PLUGIN_RULES.length);
        // 默认值：三条历史开关默认开；session header 默认关（开启会给上游多注一个头）
        expect(before.find((rule) => rule.biz_id === "SYS:setting:session_header").enabled).toBe(false);
        expect(before.filter((rule) => rule.biz_id !== "SYS:setting:session_header")
            .every((rule) => rule.enabled === true)).toBe(true);

        const response = await putConfig({ cch_rewrite_enabled: "false" });
        expect(response.status).toBe(200);
        expect(response.body.cch_rewrite_enabled).toBe("false");

        expect((await ruleByBizId("SYS:setting:cch_rewrite")).enabled).toBe(false);
        expect((await ruleByBizId("SYS:setting:claudecode_tracking_rewrite")).enabled).toBe(true);
        expect((await ruleByBizId("SYS:setting:responses_prompt_cache_key")).enabled).toBe(true);

        // 再打开一次，状态回得来（双向都同步，不是单向）
        const reopen = await putConfig({ cch_rewrite_enabled: "true" });
        expect(reopen.status).toBe(200);
        expect((await ruleByBizId("SYS:setting:cch_rewrite")).enabled).toBe(true);
    });

    it("联动只改 enabled：规则名字、优先级、插件参数保持不变", async () => {
        const before = await ruleByBizId("SYS:setting:responses_prompt_cache_key");
        await putConfig({ responses_prompt_cache_key_enabled: "false" });
        const after = await ruleByBizId("SYS:setting:responses_prompt_cache_key");

        expect(after.enabled).toBe(false);
        expect(after.name).toBe(before.name);
        expect(after.priority).toBe(before.priority);
        expect(after.config).toEqual(before.config);
        expect(after.source).toBe("system");
        expect(after.biz_id).toBe(before.biz_id);
    });

    it("旧键名仍可提交：落到新键并同步规则，旧键不出现在返回体里", async () => {
        const response = await putConfig({ claude_code_tracking_rewrite_enabled: "false" });
        expect(response.status).toBe(200);
        expect(response.body.claudecode_tracking_rewrite_enabled).toBe("false");
        expect(response.body.claude_code_tracking_rewrite_enabled).toBeUndefined();

        expect((await ruleByBizId("SYS:setting:claudecode_tracking_rewrite")).enabled).toBe(false);

        const fresh = await requestHelper.get("/config.json", adminToken);
        expect(fresh.body.claudecode_tracking_rewrite_enabled).toBe("false");
    });

    it("系统规则缺失时报错且不自动补齐，配置也不被写坏", async () => {
        await putConfig({ cch_rewrite_enabled: "true" });

        // 模拟「迁移没跑 / 被清表」：直接把规则删掉
        await dbHelper.execute("DELETE FROM rule WHERE biz_id = 'SYS:setting:cch_rewrite'");

        const failed = await putConfig({ cch_rewrite_enabled: "false" });
        expect(failed.status).toBe(500);
        expect(String(failed.body?.error ?? failed.body?.message ?? "")).toMatch(/SYS:setting:cch_rewrite/);

        // 没有自动补齐
        expect(await ruleByBizId("SYS:setting:cch_rewrite")).toBeUndefined();

        // 配置没有被写坏（预检在写配置之前）
        const current = await requestHelper.get("/config.json", adminToken);
        expect(current.body.cch_rewrite_enabled).toBe("true");
    });

    it("整份提交时任一系统规则缺失 → 整份拒绝（不会写一半）", async () => {
        await dbHelper.execute("DELETE FROM rule WHERE biz_id = 'SYS:setting:responses_prompt_cache_key'");

        const response = await putConfig({
            cch_rewrite_enabled: "false",
            responses_prompt_cache_key_enabled: "false",
        });
        expect(response.status).toBe(500);

        const current = await requestHelper.get("/config.json", adminToken);
        expect(current.body.cch_rewrite_enabled).toBe("true");
        expect(current.body.responses_prompt_cache_key_enabled).toBe("true");
    });
});
