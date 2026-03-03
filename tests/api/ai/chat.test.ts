import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import testHelpers from "../../testHelpers";
import config from "../../config";

/**
 * AI Chat Endpoint Tests
 */

let testUserId: number;
let testUserToken: string;
let openaiVendorId: number;
let anthropicVendorId: number;
let openaiModelId: number;
let openaiModelName: string;
let anthropicModelId: number;
let anthropicModelName: string;

describe("AI Chat API", () => {
    beforeAll(async () => {
        await testHelpers.truncateDatabase();

        // Create test user
        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
        );
        testUserId = userResponse.body.id;
        testUserToken = userResponse.body.token;

        // Create OpenAI vendor
        const openaiVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
        );
        openaiVendorId = openaiVendor.body.id;

        // Create Anthropic vendor
        const anthropicVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.anthropic(),
        );
        anthropicVendorId = anthropicVendor.body.id;

        // Get model names from config
        const upstreamConfig = config.getCurrentUpstreamConfig();
        openaiModelName = upstreamConfig.openai.model;
        anthropicModelName = upstreamConfig.anthropic.model;

        // Create OpenAI model
        const openaiModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openaiVendorId, openaiModelName),
        );
        openaiModelId = openaiModel.body.id;

        // Create Anthropic model
        const anthropicModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                anthropicVendorId,
                anthropicModelName,
            ),
        );
        anthropicModelId = anthropicModel.body.id;
    });

    describe("POST /v1/chat/completions", () => {
        it("should handle successful OpenAI chat request", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            const response = await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("id");
            expect(response.body).toHaveProperty("object");
            expect(response.body.object).toBe("chat.completion");
            expect(response.body).toHaveProperty("created");
            expect(response.body).toHaveProperty("model");
            expect(response.body).toHaveProperty("choices");
            expect(Array.isArray(response.body.choices)).toBe(true);
            expect(response.body.choices[0]).toHaveProperty("message");
            expect(response.body.choices[0].message.role).toBe("assistant");
            expect(response.body.choices[0].message.content).toBeTruthy();
            expect(response.body).toHaveProperty("usage");

            // Verify record was created
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
            );
            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);
            const latestRecord = recordsResponse.body[0];
            expect(latestRecord).toHaveProperty("id");
            expect(latestRecord.user_id).toBe(testUserId);
            expect(latestRecord.model_id).toBe(openaiModelId);
            expect(latestRecord.status).toBe("success");

            // Verify request_data contains sent request
            const requestData = JSON.parse(latestRecord.request_data);
            expect(requestData).toHaveProperty("model");
            expect(requestData).toHaveProperty("messages");
            expect(requestData.model).toBe(openaiModelName);

            // Verify response_data contains received response
            const responseData = JSON.parse(latestRecord.response_data);
            expect(responseData).toHaveProperty("id");
            expect(responseData).toHaveProperty("object");
            expect(responseData.object).toBe("chat.completion");
            expect(responseData).toHaveProperty("choices");
            expect(responseData.choices[0].message.content).toBe(
                response.body.choices[0].message.content,
            );

            expect(latestRecord).toHaveProperty("created_at");
            expect(latestRecord).toHaveProperty("updated_at");
        }, 30000);

        it("should handle streaming OpenAI chat request", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: true,
            });

            const response = await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(typeof response.body).toBe("string");
            expect(response.body).toContain("data:");
            expect(response.body).toContain("chat.completion.chunk");
            expect(response.body).toContain("[DONE]");

            // Verify record was created for streaming request
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
            );
            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);
            const latestRecord = recordsResponse.body[0];
            expect(latestRecord.user_id).toBe(testUserId);
            expect(latestRecord.model_id).toBe(openaiModelId);
            expect(latestRecord.status).toBe("success");

            // Verify request_data contains streaming flag
            const requestData = JSON.parse(latestRecord.request_data);
            expect(requestData.stream).toBe(true);

            // Verify response_data contains streaming response (stored as JSON string of last chunk)
            const responseData = latestRecord.response_data;
            expect(typeof responseData).toBe("string");
            const parsedResponseData = JSON.parse(responseData);
            expect(parsedResponseData).toHaveProperty("object");
            expect(parsedResponseData.object).toBe("chat.completion.chunk");
            expect(parsedResponseData).toHaveProperty("choices");
        }, 30000);

        it("should handle multiple messages in chat request", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
                messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: "Hello!" },
                    { role: "assistant", content: "Hi there!" },
                    { role: "user", content: "How are you?" },
                ],
            });

            const response = await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.choices[0].message.role).toBe("assistant");
        }, 30000);

        it("should forward custom headers and filter Cloudflare headers", async () => {
            const customHeaders = {
                "x-custom-header": "custom-value",
                "x-another-header": "another-value",
                "cf-ray": "test-cf-ray-123", // Cloudflare header - should be filtered
                "cf-ipcountry": "US", // Cloudflare header - should be filtered
                "CF-CONNECTING-IP": "1.2.3.4", // Cloudflare header (uppercase) - should be filtered
            };

            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            const response = await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
                customHeaders,
            );

            expect(response.status).toBe(200);

            // Get headers from response body (added by mock server)
            const receivedHeaders = response.body._received_headers;

            // Verify custom headers were forwarded
            expect(receivedHeaders["x-custom-header"]).toBe("custom-value");
            expect(receivedHeaders["x-another-header"]).toBe("another-value");

            // Verify Cloudflare headers were NOT forwarded
            expect(receivedHeaders["cf-ray"]).toBeUndefined();
            expect(receivedHeaders["cf-ipcountry"]).toBeUndefined();
            expect(receivedHeaders["cf-connecting-ip"]).toBeUndefined();

            // Verify authentication headers are set
            expect(receivedHeaders["authorization"] || receivedHeaders["x-api-key"]).toBeTruthy();
        }, 30000);
    });
});
