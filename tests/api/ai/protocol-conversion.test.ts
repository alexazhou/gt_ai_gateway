import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * Protocol conversion API tests
 */

let testUserId: number;
let testUserToken: string;
let adminToken: string;
let openAIClientModelId: number;
let openAIClientModelName: string;
let anthropicClientModelId: number;
let anthropicClientModelName: string;
let responsesErrorModelId: number;
let responsesErrorModelName: string;


describe("AI Protocol Conversion API", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserId = userResponse.body.id;
        testUserToken = userResponse.body.token;

        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;

        const anthropicOnlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Anthropic Only Conversion",
                token: "anthropic-conversion-token",
                urls: { anthropic: `${mockBaseUrl}/messages` },
            },
            adminToken,
        );
        openAIClientModelName = `openai-client-anthropic-upstream-${Date.now()}`;
        const openAIClientModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(anthropicOnlyVendor.body.id, openAIClientModelName),
            adminToken,
        );
        openAIClientModelId = openAIClientModel.body.id;

        const openAIOnlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Only Conversion",
                token: "openai-conversion-token",
                urls: { openai: `${mockBaseUrl}/chat/completions` },
            },
            adminToken,
        );
        anthropicClientModelName = `anthropic-client-openai-upstream-${Date.now()}`;
        const anthropicClientModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openAIOnlyVendor.body.id, anthropicClientModelName),
            adminToken,
        );
        anthropicClientModelId = anthropicClientModel.body.id;

        const responsesErrorVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Error Conversion",
                token: "responses-error-conversion-token",
                urls: { responses: `${mockBaseUrl}/responses/error` },
            },
            adminToken,
        );
        const addResponsesVendorModel = await requestHelper.post(
            `/vendor/${responsesErrorVendor.body.id}/model/add.json`,
            { model_id: "unsupported-upstream-model" },
            adminToken,
        );
        await requestHelper.put(
            `/vendor/${responsesErrorVendor.body.id}/model/${addResponsesVendorModel.body.id}.json`,
            { allowed_formats: ["responses"] },
            adminToken,
        );
        responsesErrorModelName = `anthropic-client-responses-error-${Date.now()}`;
        const responsesErrorModel = await requestHelper.post(
            "/model/create.json",
            {
                ...modelFixtures.createRandomModel(responsesErrorVendor.body.id, responsesErrorModelName),
                routing_config: {
                    upstreams: [{
                        vendor_id: responsesErrorVendor.body.id,
                        vendor_model_id: addResponsesVendorModel.body.id,
                        enabled: true,
                    }],
                },
            },
            adminToken,
        );
        responsesErrorModelId = responsesErrorModel.body.id;
    });


    it("should convert OpenAI non-stream request to Anthropic upstream and return OpenAI response", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: openAIClientModelName,
            stream: false,
        });

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            chatRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.object).toBe("chat.completion");
        expect(response.body.choices[0].message.role).toBe("assistant");
        expect(response.body.choices[0].message.content).toContain("mock Claude assistant");
        expect(response.body.usage.prompt_tokens).toBeGreaterThan(0);
        expect(response.body.usage.completion_tokens).toBeGreaterThan(0);

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(openAIClientModelId);
        expect(record.status).toBe("success");

        const responseData = JSON.parse(record.response_data);
        expect(responseData.object).toBe("chat.completion");
        expect(responseData.choices[0].message.content).toBe(response.body.choices[0].message.content);
        expect(responseData.usage.prompt_tokens).toBe(response.body.usage.prompt_tokens);
    }, 30000);


    it("should convert Anthropic non-stream request to OpenAI upstream and return Anthropic response", async () => {
        const messageRequest = mockHelper.generateAnthropicMessageRequest({
            model: anthropicClientModelName,
            stream: false,
        });

        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            messageRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.type).toBe("message");
        expect(response.body.role).toBe("assistant");
        expect(response.body.content[0].type).toBe("text");
        expect(response.body.content[0].text).toContain("mock AI assistant");
        expect(response.body.usage.input_tokens).toBeGreaterThan(0);
        expect(response.body.usage.output_tokens).toBeGreaterThan(0);

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(anthropicClientModelId);
        expect(record.status).toBe("success");

        const responseData = JSON.parse(record.response_data);
        expect(responseData.type).toBe("message");
        expect(responseData.content[0].text).toBe(response.body.content[0].text);
        expect(responseData.usage.input_tokens).toBe(response.body.usage.input_tokens);
    }, 30000);


    it("should convert OpenAI stream request to Anthropic upstream and return OpenAI SSE", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: openAIClientModelName,
            stream: true,
        });

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            chatRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(typeof response.body).toBe("string");
        expect(response.body).toContain("chat.completion.chunk");
        expect(response.body).toContain("[DONE]");
        expect(response.body).not.toContain("message_start");

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(openAIClientModelId);
        expect(record.status).toBe("success");
        const usageA = JSON.parse(record.usage);
        expect(usageA.prompt_tokens).toBeGreaterThan(0);
        expect(usageA.completion_tokens).toBeGreaterThan(0);

        const responseData = JSON.parse(record.response_data);
        expect(responseData.choices[0].message.role).toBe("assistant");
        expect(responseData.choices[0].message.content).toContain("mock Claude assistant");
        expect(responseData.usage.prompt_tokens).toBeGreaterThan(0);
    }, 30000);


    it("should convert Anthropic stream request to OpenAI upstream and return Anthropic SSE", async () => {
        const messageRequest = mockHelper.generateAnthropicMessageRequest({
            model: anthropicClientModelName,
            stream: true,
        });

        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            messageRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(typeof response.body).toBe("string");
        expect(response.body).toContain("event: message_start");
        expect(response.body).toContain("event: content_block_delta");
        expect(response.body).toContain("event: message_stop");
        expect(response.body).not.toContain("[DONE]");

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(anthropicClientModelId);
        expect(record.status).toBe("success");
        const usageB = JSON.parse(record.usage);

        const responseData = JSON.parse(record.response_data);
        expect(responseData.choices[0].message.role).toBe("assistant");
        expect(responseData.choices[0].message.content).toContain("mock AI assistant");
        expect(responseData.usage.prompt_tokens).toBeGreaterThan(0);
        expect(responseData.usage.completion_tokens).toBeGreaterThan(0);
        expect(usageB.prompt_tokens).toBe(responseData.usage.prompt_tokens);
        expect(usageB.completion_tokens).toBe(responseData.usage.completion_tokens);
        expect(usageB.cache_read_tokens).toBe(responseData.usage.cache_read_tokens);
    }, 30000);


    it("should pass through upstream non-2xx response without protocol conversion", async () => {
        const messageRequest = mockHelper.generateAnthropicMessageRequest({
            model: responsesErrorModelName,
            stream: false,
        });

        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            messageRequest,
            testUserToken,
        );

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: {
                code: "400",
                message: "Param Incorrect",
                param: "Not supported model unsupported-upstream-model",
            },
        });

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(responsesErrorModelId);
        expect(record.status).toBe("failed");
        expect(JSON.parse(record.response_data)).toEqual(response.body);
    }, 30000);


    it("should use vendor_model allowed_formats when model has no vendor_model_id but matching vendor_model exists", async () => {
        // This test verifies the auto-matching behavior:
        // When model.vendor_model_id is NULL, the system should automatically
        // find a vendor_model with matching name and use its allowed_formats.

        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;

        // 1. Create a vendor that supports both openai and anthropic
        const dualFormatVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Dual Format Vendor",
                token: "dual-format-token",
                urls: {
                    openai: `${mockBaseUrl}/chat/completions`,
                    anthropic: `${mockBaseUrl}/messages`,
                },
            },
            adminToken,
        );

        // 2. Create a vendor_model with allowed_formats = ["openai"] only
        const vendorModelResponse = await requestHelper.post(
            `/vendor/${dualFormatVendor.body.id}/model/add.json`,
            { model_id: "restricted-model" },
            adminToken,
        );
        await requestHelper.put(
            `/vendor/${dualFormatVendor.body.id}/model/${vendorModelResponse.body.id}.json`,
            { allowed_formats: ["openai"] },
            adminToken,
        );

        // 3. Create a model WITHOUT vendor_model_id (auto mode)
        // The model name matches the vendor_model's model_id
        const autoModelName = "restricted-model";
        const autoModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(dualFormatVendor.body.id, autoModelName),
            adminToken,
        );

        // 4. Send a Responses format request
        // According to the fallback priority: Responses -> [Anthropic, OpenAI]
        // If vendor_model's allowed_formats is properly used, it should pick OpenAI
        // (because allowed_formats = ["openai"])
        // If NOT properly used (bug), it falls back to vendor's full format list
        // and picks Anthropic first (higher priority in fallback list)
        const responsesRequest = mockHelper.generateOpenAIChatRequest({
            model: autoModelName,
            stream: false,
        });

        // Send as Responses format
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: autoModelName,
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "Hello" }],
                    },
                ],
                stream: false,
            },
            testUserToken,
        );

        // 5. Verify the record's upstream_format
        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];

        // The upstream_format should be "openai" (from vendor_model's allowed_formats)
        // NOT "anthropic" (which would be chosen from vendor's full format list)
        expect(record.upstream_format).toBe("openai");
    }, 30000);
});
