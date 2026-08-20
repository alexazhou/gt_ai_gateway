import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * Protocol conversion integration tests
 */

let adminToken: string;
let userId: number;
let userToken: string;
let openAIClientModelId: number;
let openAIClientModelName: string;
let anthropicClientModelId: number;
let anthropicClientModelName: string;


describe("Protocol Conversion Integration", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        expect(userResponse.status).toBe(200);
        userId = userResponse.body.id;
        userToken = userResponse.body.token;

        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;

        const anthropicOnlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Integration Anthropic Conversion Vendor",
                token: "integration-anthropic-token",
                urls: { anthropic: `${mockBaseUrl}/messages` },
            },
            adminToken,
        );
        expect(anthropicOnlyVendor.status).toBe(200);

        openAIClientModelName = `integration-openai-client-${Date.now()}`;
        const openAIClientModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(anthropicOnlyVendor.body.id, openAIClientModelName),
            adminToken,
        );
        expect(openAIClientModel.status).toBe(200);
        openAIClientModelId = openAIClientModel.body.id;

        const openAIOnlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Integration OpenAI Conversion Vendor",
                token: "integration-openai-token",
                urls: { openai: `${mockBaseUrl}/chat/completions` },
            },
            adminToken,
        );
        expect(openAIOnlyVendor.status).toBe(200);

        anthropicClientModelName = `integration-anthropic-client-${Date.now()}`;
        const anthropicClientModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openAIOnlyVendor.body.id, anthropicClientModelName),
            adminToken,
        );
        expect(anthropicClientModel.status).toBe(200);
        anthropicClientModelId = anthropicClientModel.body.id;
    });


    it("should complete OpenAI client to Anthropic upstream conversion workflow", async () => {
        const chatResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({
                model: openAIClientModelName,
                stream: false,
            }),
            userToken,
        );

        expect(chatResponse.status).toBe(200);
        expect(chatResponse.body.object).toBe("chat.completion");
        expect(chatResponse.body.choices[0].message.content).toContain("mock Claude assistant");

        const streamResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({
                model: openAIClientModelName,
                stream: true,
            }),
            userToken,
        );

        expect(streamResponse.status).toBe(200);
        expect(streamResponse.body).toContain("chat.completion.chunk");
        expect(streamResponse.body).toContain("[DONE]");

        const records = await requestHelper.getFinalizedRecords(adminToken, 2);
        expect(records.length).toBeGreaterThan(0);

        for (const record of records) {
            expect(record.user_id).toBe(userId);
            expect(record.model_id).toBe(openAIClientModelId);
            expect(record.status).toBe("success");

            const responseData = JSON.parse(record.response_data);
            expect(responseData.choices[0].message.content).toContain("mock Claude assistant");
        }
    }, 60000);


    it("should complete Anthropic client to OpenAI upstream conversion workflow", async () => {
        const messageResponse = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            mockHelper.generateAnthropicMessageRequest({
                model: anthropicClientModelName,
                stream: false,
            }),
            userToken,
        );

        expect(messageResponse.status).toBe(200);
        expect(messageResponse.body.type).toBe("message");
        expect(messageResponse.body.content[0].text).toContain("mock AI assistant");

        const streamResponse = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            mockHelper.generateAnthropicMessageRequest({
                model: anthropicClientModelName,
                stream: true,
            }),
            userToken,
        );

        expect(streamResponse.status).toBe(200);
        expect(streamResponse.body).toContain("event: message_start");
        expect(streamResponse.body).toContain("event: message_stop");

        const records = await requestHelper.getFinalizedRecords(adminToken, 2);
        expect(records.length).toBeGreaterThan(0);

        for (const record of records) {
            expect(record.user_id).toBe(userId);
            expect(record.model_id).toBe(anthropicClientModelId);
            expect(record.status).toBe("success");

            const requestData = JSON.parse(record.request_data);
            const responseData = JSON.parse(record.response_data);
            if (requestData.stream) {
                expect(responseData.choices[0].message.content).toContain("mock AI assistant");
            } else {
                expect(responseData.type).toBe("message");
                expect(responseData.content[0].text).toContain("mock AI assistant");
            }
        }
    }, 60000);
});
