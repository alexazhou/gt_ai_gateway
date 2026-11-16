/**
 * #297 PC-009-C / §4.7 的**端到端接线**用例（node 门）
 *
 * 为什么单有单测不够：#297 的判据是靠 `senderService` 在「把 model 替换成 vendor 名之前」
 * 把客户端请求名注入转换器（`updateClientModel`）才成立的。单测直接构造转换器、
 * 自己调 `updateClientModel`，所以**删掉 senderService 里那行注入，单测照样全绿**（实测：
 * 变异 M4 命中 0 红）。这一层就是补那条链。
 *
 * 场景：网关模型名（客户端请求名）≠ 上游 vendor 模型名 —— 即别名路由。
 * 上游 mock 会把收到的 model 原样回显，所以：
 * - 客户端看到 gateway 名 ⇒ 说明网关按客户端身份改写；
 * - 客户端看到 vendor 名 ⇒ 说明上游名漏了出来（改前行为）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import upstreamCaptureHelper from "../../helpers/upstreamCaptureHelper";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import protocolConverterUtil from "../../../src/util/protocolConverter/protocolConverterUtil";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

let testUserToken: string;
let adminToken: string;
/** Anthropic 上游（客户端 Responses → 转换 → Anthropic） */
let responsesClientModelName: string;
/** OpenAI 上游（客户端 Anthropic → 转换 → OpenAI） */
let anthropicClientModelName: string;

describe("#297 PC-009-C / §4.7 端到端：别名路由下客户端看到自己的模型名", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        testUserToken = userResponse.body.token;

        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;

        // ── 1. Responses 客户端 → Anthropic 上游（别名：gateway 名 ≠ vendor model_id）──
        const anthropicVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Anthropic Alias Identity",
                token: "anthropic-alias-identity-token",
                urls: { anthropic: `${mockBaseUrl}/messages` },
            },
            adminToken,
        );
        const anthropicVendorModel = await requestHelper.post(
            `/vendor/${anthropicVendor.body.id}/model/add.json`,
            { model_id: `vendor-anthropic-model-${Date.now()}` },
            adminToken,
        );
        await requestHelper.put(
            `/vendor/${anthropicVendor.body.id}/model/${anthropicVendorModel.body.id}.json`,
            { allowed_formats: ["anthropic"] },
            adminToken,
        );
        responsesClientModelName = `responses-alias-client-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            {
                ...modelFixtures.createRandomModel(anthropicVendor.body.id, responsesClientModelName),
                routing_config: {
                    upstreams: [{
                        vendor_id: anthropicVendor.body.id,
                        vendor_model_id: anthropicVendorModel.body.id,
                        enabled: true,
                    }],
                },
            },
            adminToken,
        );

        // ── 2. Anthropic 客户端 → OpenAI 上游（反方向，同样走别名）──
        const openaiVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Alias Identity",
                token: "openai-alias-identity-token",
                urls: { openai: `${mockBaseUrl}/chat/completions` },
            },
            adminToken,
        );
        const openaiVendorModel = await requestHelper.post(
            `/vendor/${openaiVendor.body.id}/model/add.json`,
            { model_id: `vendor-openai-model-${Date.now()}` },
            adminToken,
        );
        await requestHelper.put(
            `/vendor/${openaiVendor.body.id}/model/${openaiVendorModel.body.id}.json`,
            { allowed_formats: ["openai"] },
            adminToken,
        );
        anthropicClientModelName = `anthropic-alias-client-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            {
                ...modelFixtures.createRandomModel(openaiVendor.body.id, anthropicClientModelName),
                routing_config: {
                    upstreams: [{
                        vendor_id: openaiVendor.body.id,
                        vendor_model_id: openaiVendorModel.body.id,
                        enabled: true,
                    }],
                },
            },
            adminToken,
        );
    });

    it("非流式（客户端 Responses ← 上游 Anthropic）：响应 model 是客户端请求名", async () => {
        const marker = `pc009c-alias-${Date.now()}`;
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: responsesClientModelName,
                input: [{ role: "user", content: [{ type: "input_text", text: marker }] }],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.model, "客户端必须看到自己请求的模型名").toBe(responsesClientModelName);

        // 上游确实收到的是 vendor 名（证明这是别名路由，不是「名字恰好相同」）
        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => request.json?.messages?.[0]?.content === marker
                || request.json?.messages?.[0]?.content?.[0]?.text === marker);
        expect(captured.length).toBeGreaterThan(0);
        expect(captured[captured.length - 1].json.model).not.toBe(responsesClientModelName);
    }, 30000);

    it("流式（客户端 Responses ← 上游 Anthropic）：created / completed 的 model 都是客户端请求名", async () => {
        const marker = `pc009c-alias-stream-${Date.now()}`;
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: responsesClientModelName,
                input: [{ role: "user", content: [{ type: "input_text", text: marker }] }],
                stream: true,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);
        const events = String(response.body)
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s*/, ""))
            .filter((data) => data && data !== "[DONE]")
            .map((data) => JSON.parse(data));
        const created = events.find((e) => e.type === "response.created");
        const completed = events.find((e) => e.type === "response.completed");
        expect(created?.response?.model).toBe(responsesClientModelName);
        expect(completed?.response?.model).toBe(responsesClientModelName);
    }, 30000);

    it("老凭据（无 source）回放：通过，但必须在请求记录里留下「来源未校验」的 warn", async () => {
        // 模拟 #297 之前签发的凭据：payload 里没有 source 字段（现在只有老 token 会这样）
        const legacy = protocolConverterUtil.sealThinkingSignature("anthropic", "native-sig-legacy", {
            model: responsesClientModelName,
            thinking: "legacy think",
        });
        expect(legacy).not.toContain("source");

        const marker = `pc009c-legacy-${Date.now()}`;
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: responsesClientModelName,
                input: [
                    { role: "user", content: [{ type: "input_text", text: marker }] },
                    {
                        type: "reasoning",
                        summary: [{ type: "summary_text", text: "legacy think" }],
                        encrypted_content: legacy,
                    },
                ],
                stream: false,
            },
            testUserToken,
        );
        // 老凭据只校验模型、不校验来源 ⇒ 必须放行（否则升级瞬间在途多轮全挂）
        expect(response.status).toBe(200);

        const records = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const recordId = records.body[0].id;
        const activity = await requestHelper.get(`/record/${recordId}/activity.json`, adminToken);
        expect(activity.status).toBe(200);
        const unchecked = (activity.body.activities as any[]).filter(
            (a) => a.details?.credential_source_checked === false,
        );
        expect(unchecked.length, "未校验来源必须在记录里留痕，不能静默通过").toBeGreaterThan(0);
        expect(unchecked[0].details.reason).toBe("legacy_token_without_source");
        expect(unchecked[0].level).toBe("warn");
    }, 30000);

    it("反方向非流式（客户端 Anthropic ← 上游 OpenAI）：响应 model 是客户端请求名", async () => {
        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            {
                model: anthropicClientModelName,
                max_tokens: 64,
                messages: [{ role: "user", content: "pc009c-anthropic-alias" }],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.type).toBe("message");
        expect(response.body.model, "客户端必须看到自己请求的模型名").toBe(anthropicClientModelName);
    }, 30000);
});
