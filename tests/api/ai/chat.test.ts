import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";
import streamLogHelper from "../../helpers/streamLogHelper";

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
let openAIErrorModelId: number;
let openAIErrorModelName: string;
let adminToken: string;

describe("AI Chat API", () => {
    beforeAll(async () => {
        await dbHelper.truncate();

        adminToken = await setupAdminUser();

        // Create test user
        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserId = userResponse.body.id;
        testUserToken = userResponse.body.token;

        // Create OpenAI vendor
        const openaiVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        openaiVendorId = openaiVendor.body.id;

        // Create Anthropic vendor
        const anthropicVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.anthropic(),
            adminToken,
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
            adminToken,
        );
        openaiModelId = openaiModel.body.id;

        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;
        const openAIErrorVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Error Vendor",
                token: "mock-openai-error-token",
                urls: { openai: `${mockBaseUrl}/chat/completions/error` },
            },
            adminToken,
        );
        openAIErrorModelName = `openai-error-model-${Date.now()}`;
        const openAIErrorModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openAIErrorVendor.body.id, openAIErrorModelName),
            adminToken,
        );
        openAIErrorModelId = openAIErrorModel.body.id;

        // Create Anthropic model
        const anthropicModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                anthropicVendorId,
                anthropicModelName,
            ),
            adminToken,
        );
        anthropicModelId = anthropicModel.body.id;
    });

    describe("POST /llm/v1/chat/completions", () => {
        it("should handle successful OpenAI chat request", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
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
                adminToken,
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
                "/llm/v1/chat/completions",
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
                adminToken,
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
            expect(Array.isArray(parsedResponseData.choices)).toBe(true);
            expect(parsedResponseData.choices[0]).toHaveProperty("message");
            expect(parsedResponseData.choices[0].message).toHaveProperty("content");
            expect(typeof parsedResponseData.choices[0].message.content).toBe("string");
            expect(parsedResponseData.choices[0].message.content.length).toBeGreaterThan(0);
        }, 30000);

        it("should record real OpenAI tool call stream log and aggregate tool_calls", async () => {
            const chatRequest = {
                ...mockHelper.generateOpenAIChatRequest({
                    model: openaiModelName,
                    stream: true,
                    messages: [{ role: "user", content: "What is the weather in San Francisco?" }],
                }),
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "get_weather",
                            description: "Get weather by city",
                            parameters: {
                                type: "object",
                                properties: {
                                    city: { type: "string" },
                                    unit: { type: "string" },
                                },
                                required: ["city"],
                            },
                        },
                    },
                ],
            };

            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(typeof response.body).toBe("string");
            expect(response.body).toContain("\"tool_calls\"");
            expect(response.body).toContain("\"finish_reason\":\"tool_calls\"");

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            const latestRecord = recordsResponse.body[0];
            expect(latestRecord.user_id).toBe(testUserId);
            expect(latestRecord.model_id).toBe(openaiModelId);
            expect(latestRecord.status).toBe("success");

            const parsedResponseData = JSON.parse(latestRecord.response_data);
            expect(parsedResponseData.choices[0].finish_reason).toBe("tool_calls");
            expect(parsedResponseData.choices[0].message.tool_calls).toHaveLength(1);
            expect(parsedResponseData.choices[0].message.tool_calls[0].id).toBe("call_weather_001");
            expect(parsedResponseData.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
            expect(parsedResponseData.choices[0].message.tool_calls[0].function.arguments).toBe(
                "{\"city\":\"San Francisco\",\"unit\":\"celsius\"}",
            );

            // Stream log only available in node mode and when enabled
            if (config.TEST_MODE === "node" && process.env.STREAM_LOG_ENABLED === "true") {
                const { targetPath, content: streamLog } =
                    await streamLogHelper.moveStreamLogToResource(
                        latestRecord.id,
                        "openai-tool-call-stream-test.log",
                    );

                expect(targetPath.endsWith("tests/resource/stream_logs/openai-tool-call-stream-test.log")).toBe(true);
                expect(streamLog).toContain("\"tool_calls\"");
                expect(streamLog).toContain("\"get_weather\"");
                expect(streamLog).toContain("\"finish_reason\":\"tool_calls\"");
            }
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
                "/llm/v1/chat/completions",
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
                "/llm/v1/chat/completions",
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

    describe("vendor_model_id substitution", () => {
        it("should substitute gateway model name with vendor model_id in upstream request", async () => {
            // Add a vendor model that represents the real upstream model name
            const addVmRes = await requestHelper.post(
                `/vendor/${openaiVendorId}/model/add.json`,
                { model_id: "actual-upstream-model-id" },
                adminToken,
            );
            const vendorModelId = addVmRes.body.id;

            // Create a gateway model with a different name, linked to the vendor model
            const createModelRes = await requestHelper.post(
                "/model/create.json",
                {
                    name: "gateway-alias-model",
                    vendor_id: openaiVendorId,
                    vendor_model_id: vendorModelId,
                    enable: true,
                },
                adminToken,
            );
            expect(createModelRes.status).toBe(200);

            // Send a chat request using the gateway alias name
            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                {
                    model: "gateway-alias-model",
                    messages: [{ role: "user", content: "ping" }],
                    stream: false,
                },
                testUserToken,
            );

            expect(response.status).toBe(200);
            // The mock server echoes back data.model — should be the substituted upstream id
            expect(response.body.model).toBe("actual-upstream-model-id");

            // Verify the record captured vendor_id and the actual vendor_model_name
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            const latestRecord = recordsResponse.body[0];
            expect(latestRecord.vendor_id).toBe(openaiVendorId);
            expect(latestRecord.vendor_model_name).toBe("actual-upstream-model-id");
        });

        it("should use gateway model name as-is when vendor_model_id is null and record it correctly", async () => {
            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                {
                    model: openaiModelName,
                    messages: [{ role: "user", content: "ping" }],
                    stream: false,
                },
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.model).toBe(openaiModelName);

            // Verify the record captured vendor_id and vendor_model_name
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            const latestRecord = recordsResponse.body[0];
            expect(latestRecord.vendor_id).toBe(openaiVendorId);
            expect(latestRecord.vendor_model_name).toBe(openaiModelName);
        });
    });

    describe("upstream error passthrough", () => {
        it("should pass through OpenAI upstream 400 response", async () => {
            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                {
                    model: openAIErrorModelName,
                    messages: [{ role: "user", content: "ping" }],
                    stream: false,
                },
                testUserToken,
            );

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: {
                    message: `Not supported model ${openAIErrorModelName}`,
                    type: "invalid_request_error",
                    param: "model",
                    code: "model_not_supported",
                },
            });

            const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordsResponse.body[0];
            expect(record.user_id).toBe(testUserId);
            expect(record.model_id).toBe(openAIErrorModelId);
            expect(record.status).toBe("failed");
            expect(JSON.parse(record.response_data)).toEqual(response.body);
        }, 30000);
    });
});
