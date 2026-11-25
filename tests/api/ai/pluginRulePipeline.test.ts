import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import upstreamCaptureHelper, { type CapturedRequest } from "../../helpers/upstreamCaptureHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * T5：sender 管线接入插件（同协议 / 跨协议前置条件 / 多规则叠加 / 作用域 / 停用 / 异常容错 / 留痕）。
 *
 * 判据都落在**上游真实收到的请求体**上（mock 上游会把收到的请求抓下来），而不是"规则表里有什么"：
 * 规则存在 ≠ 生效，插件链路的失败模式恰恰是"规则在、请求没改"。
 *
 * 留痕口径：一次请求只有**一条** `plugin` 阶段事件，`details.executed` 是按执行顺序的数组。
 */

let adminToken: string;
let userToken: string;
let anthropicModelName: string;

const BILLING_PREFIX = "x-anthropic-billing-header: cc_version=2.1.153.9bb; cch=5a235;";


function systemPromptWith(marker: string): string {
    // 首段必须是 billing header（CCH 插件只处理首段），日期块给 tracking 插件处理
    return `${BILLING_PREFIX} ${marker}\n# currentDate\nToday's date is 2026/06/30.\nFollow the instructions.`;
}


function buildAnthropicRequest(marker: string) {
    return {
        ...mockHelper.generateAnthropicMessageRequest({ model: anthropicModelName, stream: false }),
        system: systemPromptWith(marker),
    };
}


/** 上游请求里的 system 文本（anthropic 允许字符串或 text block 数组两种形态） */
function systemTextOf(json: any): string {
    const system = json?.system;
    if (typeof system === "string") {
        return system;
    }
    if (Array.isArray(system)) {
        return system.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("\n");
    }
    return "";
}


/** 等 mock 上游抓到这次请求（用 system 里的唯一 marker 定位，避免同一用例内多次请求串味） */
async function waitForUpstream(marker: string, timeoutMs = 5000): Promise<CapturedRequest> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const all = await upstreamCaptureHelper.list();
        const hit = all.filter((item) => systemTextOf(item.json).includes(marker));
        if (hit.length > 0) {
            return hit[hit.length - 1];
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`upstream did not receive the request carrying marker ${marker}`);
}


async function sendAnthropic(marker: string) {
    const response = await requestHelper.post("/llm/v1/messages", buildAnthropicRequest(marker), userToken);
    expect(response.status).toBe(200);
    return await waitForUpstream(marker);
}


/** 最近一条记录的 plugin 阶段活动（一次请求应只有一条） */
async function pluginActivities(): Promise<any[]> {
    const records = await requestHelper.getFinalizedRecords(adminToken, 1);
    expect(records.length).toBeGreaterThan(0);
    const recordId = records[0].id;
    const activity = await requestHelper.get(`/record/${recordId}/activity.json`, adminToken);
    expect(activity.status).toBe(200);
    return (activity.body.activities as any[]).filter((item) => item.stage === "plugin");
}


async function createUserPluginRule(overrides: Record<string, unknown> = {}) {
    const response = await requestHelper.post("/rule/create.json", {
        type: "plugin",
        name: `plugin-rule-${randomUUID().slice(0, 8)}`,
        scope: { type: "const", values: [true] },
        config: { plugin: "cchRewriter", pluginConfig: { cchValue: "B5678" } },
        priority: 100,
        ...overrides,
    }, adminToken);
    expect(response.status).toBe(200);
    return response.body;
}


async function clearServerCaches() {
    await requestHelper.del("/test/cache/clear", adminToken);
}


describe("T5 插件管线（sender 集成）", () => {
    // 每个用例独立建场：规则是全局生效的，用例之间共用会互相污染
    // （比如"叠加"用例建的用户 cch 规则会把后续用例的期望值改掉）
    beforeEach(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const user = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        expect(user.status).toBe(200);
        userToken = user.body.token;

        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.anthropic(),
            adminToken,
        );
        expect(vendor.status).toBe(200);

        anthropicModelName = `plugin-model-${Date.now()}`;
        const model = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(vendor.body.id, anthropicModelName),
            adminToken,
        );
        expect(model.status).toBe(200);
    });

    it("系统规则（tracking 10 + CCH 20）在同协议请求上生效，且只写一条 plugin 事件", async () => {
        const marker = `sys-${randomUUID()}`;
        const upstream = await sendAnthropic(marker);

        expect(upstream.json.system).toContain("cch=A1234;");
        expect(upstream.json.system).toContain("2026-06-30");
        expect(upstream.json.system).not.toContain("2026/06/30");

        const events = await pluginActivities();
        expect(events).toHaveLength(1);
        const executed = events[0].details.executed;
        expect(executed.map((item: any) => item.priority)).toEqual([10, 20]);
        expect(executed.map((item: any) => item.plugin)).toEqual([
            "claudeCodeTrackingRewriter",
            "cchRewriter",
        ]);
        expect(executed[0].paths).toEqual(["/system"]);
        // 只记路径不记内容：details 里不应出现请求体原文片段
        expect(JSON.stringify(events[0].details)).not.toContain("Follow the instructions");
    });

    it("用户规则（priority 100）叠加在系统规则之后：最终 cch 取后执行的那条", async () => {
        await createUserPluginRule();
        const marker = `stack-${randomUUID()}`;
        const upstream = await sendAnthropic(marker);

        // 系统规则先改 A1234，用户规则后改 B5678 ⇒ 最终 B5678
        expect(upstream.json.system).toContain("cch=B5678;");
        expect(upstream.json.system).not.toContain("A1234");

        const events = await pluginActivities();
        expect(events).toHaveLength(1);
        expect(events[0].details.executed.map((item: any) => item.priority)).toEqual([10, 20, 100]);
    });

    it("作用域不命中时不执行（scope 指到别的模型）", async () => {
        await createUserPluginRule({
            scope: { type: "model_id", oper: "=", values: [999999] },
        });
        const marker = `scope-miss-${randomUUID()}`;
        const upstream = await sendAnthropic(marker);

        expect(upstream.json.system).toContain("cch=A1234;");
        expect(upstream.json.system).not.toContain("B5678");

        const events = await pluginActivities();
        expect(events[0].details.executed).toHaveLength(2);   // 只有两条系统规则
    });

    it("停用用户规则后不再执行", async () => {
        const rule = await createUserPluginRule();
        const disabled = await requestHelper.put(`/rule/${rule.id}`, {
            type: "plugin",
            name: rule.name,
            scope: rule.scope,
            config: rule.config,
            enabled: false,
        }, adminToken);
        expect(disabled.status).toBe(200);

        const marker = `disabled-${randomUUID()}`;
        const upstream = await sendAnthropic(marker);
        expect(upstream.json.system).toContain("cch=A1234;");
        expect(upstream.json.system).not.toContain("B5678");
    });

    it("关掉「强制改写 CCH」开关 ⇒ 请求期不再改写（读归口：运行期只认规则）", async () => {
        const off = await requestHelper.put("/config.json", { cch_rewrite_enabled: "false" }, adminToken);
        expect(off.status).toBe(200);

        try {
            const marker = `switch-off-${randomUUID()}`;
            const upstream = await sendAnthropic(marker);
            // CCH 未改写：保留客户端原值
            expect(upstream.json.system).toContain("cch=5a235;");
            expect(upstream.json.system).not.toContain("cch=A1234;");
            // tracking 规则仍是开的（只关了一个开关）
            expect(upstream.json.system).toContain("2026-06-30");
        } finally {
            const on = await requestHelper.put("/config.json", { cch_rewrite_enabled: "true" }, adminToken);
            expect(on.status).toBe(200);
        }
    });

    it("插件名被改坏（未注册）时不阻断请求，留一条 warn 与 issues", async () => {
        const rule = await createUserPluginRule();
        // 绕过保存校验直接改库：模拟"规则引用了已下线/拼错的插件"
        await dbHelper.execute(
            `UPDATE rule SET config = '{"plugin":"noSuchPlugin","pluginConfig":{}}' WHERE id = ${rule.id}`,
        );
        await clearServerCaches();

        const marker = `broken-${randomUUID()}`;
        const upstream = await sendAnthropic(marker);

        // 系统规则照常生效，坏规则只影响它自己
        expect(upstream.json.system).toContain("cch=A1234;");

        const events = await pluginActivities();
        expect(events).toHaveLength(1);
        expect(events[0].level).toBe("warn");
        expect(events[0].details.issues.some((issue: any) => issue.reason === "plugin is not registered")).toBe(true);
        expect(events[0].details.executed.map((item: any) => item.priority)).toEqual([10, 20]);

        // 复原，避免污染后续用例
        await dbHelper.execute(
            `UPDATE rule SET config = '{"plugin":"cchRewriter","pluginConfig":{"cchValue":"B5678"}}' WHERE id = ${rule.id}`,
        );
        await clearServerCaches();
    });

    it("failover 切到新供应商后按新 vendor 重新匹配插件规则", async () => {
        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;

        // A 指向错误端点（首个上游必失败），B 正常
        const vendorA = await requestHelper.post("/vendor/create.json", {
            type: "other",
            name: `failover-a-${Date.now()}`,
            token: "mock-token-a",
            urls: { anthropic: `${mockBaseUrl}/messages/error` },
        }, adminToken);
        const vendorB = await requestHelper.post("/vendor/create.json", vendorFixtures.VENDOR_FIXTURES.anthropic(), adminToken);
        expect(vendorA.status).toBe(200);
        expect(vendorB.status).toBe(200);

        const modelName = `failover-model-${Date.now()}`;
        // first_available 自动上游：两个供应商都要有同名 vendor model
        await requestHelper.post(`/vendor/${vendorA.body.id}/model/add.json`, { model_id: modelName }, adminToken);
        await requestHelper.post(`/vendor/${vendorB.body.id}/model/add.json`, { model_id: modelName }, adminToken);

        const model = await requestHelper.post("/model/create.json", {
            name: modelName,
            routing_mode: "first_available",
            routing_config: {
                upstreams: [
                    { vendor_id: vendorA.body.id, enabled: true },
                    { vendor_id: vendorB.body.id, enabled: true },
                ],
                failover: { enabled: true },
            },
        }, adminToken);
        expect(model.status).toBe(200);

        // 规则只对 B 生效：只有在"切到 B 之后重新匹配"才会看到这条规则的改写
        await createUserPluginRule({
            scope: { type: "vendor_id", oper: "=", values: [vendorB.body.id] },
            config: { plugin: "cchRewriter", pluginConfig: { cchValue: "C9999" } },
            priority: 50,
        });

        const marker = `failover-${randomUUID()}`;
        const response = await requestHelper.post("/llm/v1/messages", {
            ...mockHelper.generateAnthropicMessageRequest({ model: modelName, stream: false }),
            system: systemPromptWith(marker),
        }, userToken);
        expect(response.status).toBe(200);

        const upstream = await waitForUpstream(marker);
        const systemText = systemTextOf(upstream.json);
        // 系统规则先改 A1234，走到 B 时命中的用户规则再改成 C9999
        expect(systemText).toContain("cch=C9999;");
        expect(systemText).not.toContain("A1234");
    });

    it("跨协议（openai 客户端 → anthropic 上游）时插件在转换后阶段生效", async () => {
        // 直接调 anthropic 风格端点，但声明 openai 格式的上游 —— 需要一条 openai→anthropic 的模型
        const vendor = await requestHelper.post("/vendor/create.json", {
            type: "other",
            name: `openai-client-vendor-${Date.now()}`,
            token: "mock-token",
            urls: { anthropic: config.UPSTREAM_CONFIG.mock.url },
        }, adminToken);
        expect(vendor.status).toBe(200);

        const modelName = `cross-protocol-model-${Date.now()}`;
        const model = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(vendor.body.id, modelName),
            adminToken,
        );
        expect(model.status).toBe(200);

        // 客户端用 OpenAI 格式请求（system 走 messages，转成 anthropic 后 CCH 片段会被搬进 system）
        const marker = `cross-${randomUUID()}`;
        const response = await requestHelper.post("/llm/v1/chat/completions", {
            model: modelName,
            stream: false,
            messages: [
                { role: "system", content: systemPromptWith(marker) },
                { role: "user", content: "hello" },
            ],
        }, userToken);
        expect(response.status).toBe(200);

        const upstream = await waitForUpstream(marker);
        // 上游收到的是 anthropic 格式，且插件在转换后阶段生效
        const systemText = systemTextOf(upstream.json);
        expect(systemText).toContain("cch=A1234;");
        expect(systemText).toContain("2026-06-30");

        const events = await pluginActivities();
        expect(events).toHaveLength(1);
        expect(events[0].details.executed.every((item: any) => item.hook === "after_conversion")).toBe(true);
        expect(events[0].details.executed.map((item: any) => item.priority)).toEqual([10, 20]);
    });
    it("自动生成 session header：开启后上游收到 x-session-id，同会话多轮不变、换首条消息即换 id", async () => {
        const opened = await requestHelper.put("/config.json", { session_header_enabled: "true" }, adminToken);
        expect(opened.status).toBe(200);
        await clearServerCaches();

        const marker = `session-${randomUUID()}`;
        const firstUser = `首条消息-${randomUUID()}`;

        const send = async (messages: any[]) => {
            const response = await requestHelper.post("/llm/v1/messages", {
                ...mockHelper.generateAnthropicMessageRequest({ model: anthropicModelName, stream: false, messages }),
                system: systemPromptWith(marker),
            }, userToken);
            expect(response.status).toBe(200);
            return await waitForUpstream(marker);
        };

        const first = await send([{ role: "user", content: firstUser }]);
        const firstSessionId = first.headers["x-session-id"];
        expect(firstSessionId, "上游必须收到 x-session-id").toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

        // 会话往下长：客户端每轮都重发完整历史，首条消息与 system prompt 不变 ⇒ id 必须不变
        const second = await send([
            { role: "user", content: firstUser },
            { role: "assistant", content: "好的" },
            { role: "user", content: "第二轮" },
        ]);
        expect(second.headers["x-session-id"]).toBe(firstSessionId);

        // 换了会话（首条消息不同）⇒ 必须是另一个 id
        const other = await send([{ role: "user", content: `另一段会话-${randomUUID()}` }]);
        expect(other.headers["x-session-id"]).toBeTruthy();
        expect(other.headers["x-session-id"]).not.toBe(firstSessionId);
    });

    it("自动生成 session header：开关关闭时上游收不到该头（默认关闭）", async () => {
        const marker = `no-session-${randomUUID()}`;
        const response = await requestHelper.post("/llm/v1/messages", {
            ...mockHelper.generateAnthropicMessageRequest({ model: anthropicModelName, stream: false }),
            system: systemPromptWith(marker),
        }, userToken);
        expect(response.status).toBe(200);

        const upstream = await waitForUpstream(marker);
        expect(upstream.headers["x-session-id"]).toBeUndefined();
    });
});
