import { beforeEach, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import userFixtures from "../../fixtures/userFixtures";
import { SYSTEM_PLUGIN_RULES } from "../../../src/plugin/systemRules";

/**
 * 规则「来源 + 优先级」的接口层行为（T3，design/2026-11-24-generic-plugin step2_technical §3.1~§3.3）：
 *
 * - 列表按执行顺序 `(priority ASC, id ASC)` 返回，而不是按创建时间倒序；
 * - `?source=user|system` 筛选，非法值 400；
 * - 系统规则在接口层完全只读：改 / 删一律 403，**且 403 先于参数校验 400**；
 * - 创建规则时忽略请求体里的 `source` / `biz_id`（系统规则只能由迁移预置 + 高级设置联动）；
 * - `priority` 校验 `0 ~ 10000` 整数，未传则走 DB 默认值 100；
 * - `GET /rule/plugins.json` 不被 `/rule/:id` 抢路由。
 *
 * 系统规则由 `dbHelper.truncate()` 在清表后重建（`seedSystemRules`）：运行期的开关真源就是这三条，
 * 不给它们建好，所有"改开关"的用例都会 500、请求路径上的插件还会静默不生效。
 */
const adminToken = userFixtures.ADMIN_TOKEN;

/** 系统规则按 biz_id 定位（名字/优先级都来自 SYSTEM_PLUGIN_RULES，避免测试里再写死一份） */
function systemRuleName(bizId: string): string {
    const definition = SYSTEM_PLUGIN_RULES.find((item) => item.bizId === bizId);
    if (!definition) {
        throw new Error(`unknown system rule: ${bizId}`);
    }
    return definition.name;
}

function userRule(overrides: Record<string, unknown> = {}) {
    return {
        type: "rate_limit",
        name: `user-rl-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        scope: { type: "const", values: [true] },
        config: { rpm: 100 },
        ...overrides,
    };
}

async function createRule(payload: Record<string, unknown>) {
    return await requestHelper.post("/rule/create.json", payload, adminToken);
}

describe("Rule API: 来源、优先级与只读保护", () => {
    beforeEach(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
    });

    it("列表按 (priority ASC, id ASC) 返回执行顺序，不再是创建时间倒序", async () => {
        const late = await createRule(userRule({ name: "p200", priority: 200 }));
        const early = await createRule(userRule({ name: "p50", priority: 50 }));
        expect(late.status).toBe(200);
        expect(early.status).toBe(200);

        const list = await requestHelper.get("/rule/list.json", adminToken);
        expect(list.status).toBe(200);
        expect(list.body.list.map((rule: any) => rule.name)).toEqual([
            systemRuleName("SYS:setting:claudecode_tracking_rewrite"),
            systemRuleName("SYS:setting:cch_rewrite"),
            systemRuleName("SYS:setting:responses_prompt_cache_key"),
            systemRuleName("SYS:setting:session_header"),
            "p50",
            "p200",
        ]);
        expect(list.body.list.map((rule: any) => rule.priority)).toEqual([10, 20, 30, 40, 50, 200]);
    });

    it("同优先级按 id 升序（后建的同优先级规则排在后面）", async () => {
        const first = await createRule(userRule({ name: "same-a", priority: 100 }));
        const second = await createRule(userRule({ name: "same-b", priority: 100 }));

        // 只看用户规则区（系统规则优先级 10/20/30 恒在前）
        const list = await requestHelper.get("/rule/list.json?source=user", adminToken);
        const names = list.body.list.map((rule: any) => rule.name);
        expect(names).toEqual(["same-a", "same-b"]);
        expect(first.body.id).toBeLessThan(second.body.id);
    });

    it("?source= 筛选：system 只有系统规则、user 只有用户规则", async () => {
        await createRule(userRule({ name: "mine", priority: 100 }));

        const systemList = await requestHelper.get("/rule/list.json?source=system", adminToken);
        expect(systemList.status).toBe(200);
        expect(systemList.body.total).toBe(SYSTEM_PLUGIN_RULES.length);
        expect(systemList.body.list.every((rule: any) => rule.source === "system")).toBe(true);

        const userList = await requestHelper.get("/rule/list.json?source=user", adminToken);
        expect(userList.status).toBe(200);
        expect(userList.body.list.map((rule: any) => rule.name)).toEqual(["mine"]);

        const all = await requestHelper.get("/rule/list.json", adminToken);
        expect(all.body.total).toBe(SYSTEM_PLUGIN_RULES.length + 1);

        const bad = await requestHelper.get("/rule/list.json?source=weird", adminToken);
        expect(bad.status).toBe(400);
    });

    it("系统规则改 / 删一律 403，且数据未被改动", async () => {
        const list = await requestHelper.get("/rule/list.json?source=system", adminToken);
        const cch = list.body.list.find((rule: any) => rule.biz_id === "SYS:setting:cch_rewrite");

        const updated = await requestHelper.put(`/rule/${cch.id}`, {
            type: "plugin",
            name: "hijacked",
            scope: { type: "const", values: [true] },
            config: { plugin: "cchRewriter", pluginConfig: {} },
            enabled: false,
        }, adminToken);
        expect(updated.status).toBe(403);

        const deleted = await requestHelper.del(`/rule/${cch.id}`, adminToken);
        expect(deleted.status).toBe(403);

        const detail = await requestHelper.get(`/rule/${cch.id}`, adminToken);
        expect(detail.status).toBe(200);
        expect(detail.body.name).toBe(systemRuleName("SYS:setting:cch_rewrite"));
        expect(detail.body.enabled).toBe(true);
    });

    it("系统规则的非法请求体也返回 403（只读判定先于参数校验）", async () => {
        const list = await requestHelper.get("/rule/list.json?source=system", adminToken);
        const target = list.body.list[0];

        // 这份 body 自身就不合法（priority 越界 + type 不认识），但对象是系统规则 → 必须先 403
        const response = await requestHelper.put(`/rule/${target.id}`, {
            type: "no-such-type",
            scope: { type: "const", values: [true] },
            priority: 999999,
        }, adminToken);
        expect(response.status).toBe(403);
    });

    it("创建时忽略请求体的 source / biz_id，用户规则永远 source=user / biz_id=null", async () => {
        const created = await createRule(userRule({
            name: "sneaky",
            source: "system",
            biz_id: "SYS:setting:my_fake_rule",
        }));
        expect(created.status).toBe(200);
        expect(created.body.source).toBe("user");
        expect(created.body.biz_id).toBeNull();
    });

    it("priority 校验：0 与 10000 合法，越界 / 小数 / 字符串 / null 一律 400，未传默认 100", async () => {
        const min = await createRule(userRule({ name: "p-min", priority: 0 }));
        expect(min.status).toBe(200);
        expect(min.body.priority).toBe(0);

        const max = await createRule(userRule({ name: "p-max", priority: 10000 }));
        expect(max.status).toBe(200);
        expect(max.body.priority).toBe(10000);

        const fallback = await createRule(userRule({ name: "p-default" }));
        expect(fallback.status).toBe(200);
        expect(fallback.body.priority).toBe(100);

        for (const priority of [-1, 10001, 1.5, "50", null, true]) {
            const response = await createRule(userRule({ priority }));
            expect(response.status, `priority=${JSON.stringify(priority)} 应被拒绝`).toBe(400);
        }
    });

    it("更新时 priority 可改，未传则保持原值", async () => {
        const created = await createRule(userRule({ name: "to-update", priority: 500 }));
        const updated = await requestHelper.put(`/rule/${created.body.id}`, {
            type: "rate_limit",
            name: "to-update",
            scope: { type: "const", values: [true] },
            config: { rpm: 100 },
            priority: 7,
        }, adminToken);
        expect(updated.status).toBe(200);
        expect(updated.body.priority).toBe(7);

        const updatedWithoutPriority = await requestHelper.put(`/rule/${created.body.id}`, {
            type: "rate_limit",
            name: "to-update",
            scope: { type: "const", values: [true] },
            config: { rpm: 100 },
        }, adminToken);
        expect(updatedWithoutPriority.status).toBe(200);
        expect(updatedWithoutPriority.body.priority).toBe(7);
    });

    it("GET /rule/plugins.json 不被 /rule/:id 抢路由，返回已注册插件数组", async () => {
        const response = await requestHelper.get("/rule/plugins.json", adminToken);
        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
    });

    it("插件规则：未注册的插件名被拒绝（400），不落库", async () => {
        const created = await createRule({
            type: "plugin",
            name: "bad-plugin-rule",
            scope: { type: "const", values: [true] },
            config: { plugin: "noSuchPlugin", pluginConfig: {} },
        });
        expect(created.status).toBe(400);

        // 清表后重建的 3 条系统规则仍在，但不应多出这条插件规则
        const list = await requestHelper.get("/rule/list.json?source=user", adminToken);
        expect(list.body.total).toBe(0);
    });
});
