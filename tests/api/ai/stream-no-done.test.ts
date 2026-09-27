import { describe, it, expect, beforeAll } from "vitest";
import { fetch } from "undici";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";
import modelFixtures from "../../fixtures/modelFixtures";

/**
 * 上游流式「干净 EOF 但不发 [DONE]」的处理。
 *
 * 部分 OpenAI 兼容上游按 stream_options.include_usage 报文：内容、finish_reason、usage 都发全，
 * 然后直接以 chunked 终止块关闭连接，不发 [DONE]。此时数据是完整的，缺的只是 OpenAI 协议里
 * 那个冗余的终止标记，因此：
 * - 记账应判成功（usage 入库、正常计费），而不是 unknown_error；
 * - 转换链路（Anthropic 客户端）应收到完整的终止事件（message_delta + message_stop），
 *   而不是一条缺 stop_reason / usage 的截断流。
 *
 * 真截断（没发 finish_reason 就关闭）仍应记 failed —— 见 stream-failure.test.ts。
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url;

let testUserToken: string;
let adminToken: string;
let noDoneModelName: string;
let noDoneNoUsageModelName: string;

describe("Upstream clean EOF without [DONE]", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserToken = userResponse.body.token;

        // 上游：内容 + finish_reason + usage 齐全，然后直接关闭（不发 [DONE]）
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI No Done",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/no-done` },
            },
            adminToken,
        );
        expect(vendor.status).toBe(200);

        noDoneModelName = `openai-no-done-${Date.now()}`;
        const model = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(vendor.body.id, noDoneModelName),
            adminToken,
        );
        expect(model.status).toBe(200);

        // 上游连 usage 帧也不发（忽略 include_usage），同样省略 [DONE]
        const noUsageVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI No Done No Usage",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/no-done-no-usage` },
            },
            adminToken,
        );
        expect(noUsageVendor.status).toBe(200);

        noDoneNoUsageModelName = `openai-no-done-no-usage-${Date.now()}`;
        const noUsageModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(noUsageVendor.body.id, noDoneNoUsageModelName),
            adminToken,
        );
        expect(noUsageModel.status).toBe(200);
    });

    it("OpenAI 直通：记为 success，且 usage 正常入库", async () => {
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: noDoneModelName, messages: [{ role: "user", content: "hi" }], stream: true },
            testUserToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("success");
        expect(record.failed_code).toBeNull();
        // usage 入库是「累加器已完成」的直接证据；缺 [DONE] 时当前不会写入
        expect(record.usage).toBeTruthy();
        expect(record.usage.prompt_tokens).toBe(11);
        expect(record.usage.completion_tokens).toBe(7);
    }, 15000);

    it("Anthropic 客户端 → OpenAI 上游：客户端收到完整终止事件，且记为 success", async () => {
        const baseUrl = config.SERVER_CONFIG.baseUrl;
        const res = await fetch(`${baseUrl}/llm/v1/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${testUserToken}`,
            },
            body: JSON.stringify({
                model: noDoneModelName,
                messages: [{ role: "user", content: "hi" }],
                stream: true,
                max_tokens: 100,
            }),
        } as any);
        expect(res.status).toBe(200);

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let sseText = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseText += decoder.decode(value, { stream: true });
        }

        // 内容正常送达
        expect(sseText).toContain("content_block_delta");
        // 终止事件补齐：stop_reason 与 message_stop 都不应缺失
        expect(sseText).toContain("message_delta");
        expect(sseText).toContain("message_stop");
        expect(sseText).toContain("\"stop_reason\":\"end_turn\"");

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];
        expect(record.status).toBe("success");
        expect(record.failed_code).toBeNull();
    }, 15000);

    it("Responses 客户端 → OpenAI 上游（连 usage 帧也没有）：收到 response.completed，且记为 success", async () => {
        const res = await fetch(`${config.SERVER_CONFIG.baseUrl}/llm/v1/responses`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${testUserToken}`,
            },
            body: JSON.stringify({
                model: noDoneNoUsageModelName,
                input: "hi",
                stream: true,
            }),
        } as any);
        expect(res.status).toBe(200);

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let sseText = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseText += decoder.decode(value, { stream: true });
        }
        expect(sseText).toContain("response.completed");

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];
        expect(record.status).toBe("success");
        expect(record.failed_code).toBeNull();
    }, 15000);
});
