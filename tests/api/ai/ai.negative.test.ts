import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * AI Endpoint Negative Tests
 */

let testUserToken: string;
let disabledUserToken: string;
let openaiVendorId: number;
let anthropicVendorId: number;
let openaiModelName: string;
let anthropicModelName: string;
let adminToken: string;

describe("AI Chat API (Negative)", () => {
    beforeAll(async () => {
        await dbHelper.truncate();

        adminToken = await setupAdminUser();

        // Create test user
        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserToken = userResponse.body.token;

        // Create disabled test user
        const disabledUserResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        disabledUserToken = disabledUserResponse.body.token;
        await requestHelper.put(
            `/user/${disabledUserResponse.body.id}`,
            { status: "disabled" },
            adminToken
        );

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
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openaiVendorId, openaiModelName),
            adminToken,
        );

        // Create Anthropic model
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                anthropicVendorId,
                anthropicModelName,
            ),
            adminToken,
        );

        // Insert an invalid routing config to verify unavailable-upstream handling.
        await dbHelper.execute(
            `INSERT INTO model (name, enable, routing_mode, routing_config)
             VALUES ('vendor-not-found-model', 1, 'single', '{"upstreams":[{"vendor_id":999999,"enabled":true}]}')`,
        );
    });

    describe("POST /llm/v1/chat/completions", () => {
        it("should return 401 when Authorization header is missing", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
            });

            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                undefined,
            );

            expect(response.status).toBe(401);
            expect(response.body).toEqual({
                error: {
                    message: expect.stringContaining("Authorization"),
                    type: "authentication_error",
                    param: null,
                    code: "authentication_error"
                }
            });
        }, 30000);

        it.each([
            "Basic invalid-token",
            "Bearer",
        ])("should return 401 when Authorization header is malformed: %s", async (authorization) => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
            });

            const response = await requestHelper.request("/llm/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": authorization },
                body: JSON.stringify(chatRequest),
            });

            expect(response.status).toBe(401);
            expect(response.body.error).toEqual({
                message: "Invalid Authorization header",
                type: "authentication_error",
                param: null,
                code: "authentication_error",
            });
        }, 30000);

        it("should treat a blank x-api-key as missing", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
            });

            const response = await requestHelper.request("/llm/v1/chat/completions", {
                method: "POST",
                headers: { "x-api-key": "   " },
                body: JSON.stringify(chatRequest),
            });

            expect(response.status).toBe(401);
            expect(response.body.error.type).toBe("authentication_error");
        }, 30000);

        it("should return 401 when token is invalid", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
            });

            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                "invalid-token-12345",
            );

            expect(response.status).toBe(401);
            expect(response.body).toEqual({
                error: {
                    message: expect.stringContaining("user not found"),
                    type: "authentication_error",
                    param: null,
                    code: "authentication_error"
                }
            });
        }, 30000);

        it("should return 403 when user is disabled", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
            });

            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                disabledUserToken,
            );

            expect(response.status).toBe(403);
            expect(response.body).toEqual({
                error: {
                    message: expect.stringContaining("User disabled"),
                    type: "authentication_error",
                    param: null,
                    code: "authentication_error"
                }
            });
        }, 30000);

        it("should return 400 when the JSON body is malformed", async () => {
            const response = await requestHelper.request("/llm/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${testUserToken}` },
                body: "{",
            });

            expect(response.status).toBe(400);
            expect(response.body.error).toEqual({
                message: "Invalid JSON body",
                type: "invalid_request_error",
                param: null,
                code: "invalid_request_error",
            });
        }, 30000);

        it.each([
            ["null", "null"],
            ["an array", "[]"],
            ["a string", "\"text\""],
            ["a number", "42"],
        ])("should return 400 when the JSON body is %s", async (_description, body) => {
            const response = await requestHelper.request("/llm/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${testUserToken}` },
                body,
            });

            expect(response.status).toBe(400);
            expect(response.body.error).toEqual({
                message: "Request body must be a JSON object",
                type: "invalid_request_error",
                param: null,
                code: "invalid_request_error",
            });
        }, 30000);

        it.each([
            ["missing", {}],
            ["not a string", { model: 123 }],
            ["blank", { model: "   " }],
        ])("should return 400 when model is %s", async (_description, body) => {
            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                body,
                testUserToken,
            );

            expect(response.status).toBe(400);
            expect(response.body.error).toEqual({
                message: "model parameter is missing or invalid",
                type: "invalid_request_error",
                param: null,
                code: "invalid_request_error",
            });
        }, 30000);

        it("should return 401 when model does not exist", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: "non-existent-model",
            });

            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            expect(response.status).toBe(404);
            expect(response.body).toEqual({
                error: {
                    message: expect.stringContaining("model not found"),
                    type: "not_found_error",
                    param: null,
                    code: "not_found_error"
                }
            });

            // Verify a failed record was created in the database
            const records = dbHelper.query<any>("SELECT * FROM record ORDER BY id DESC LIMIT 1");
            const latestRecord = records[0];
            expect(latestRecord).toBeDefined();
            expect(latestRecord!.status).toBe("failed");
            expect(latestRecord!.failed_code).toBe("model_not_found");
            expect(latestRecord!.model_id).toBeNull();
            expect(latestRecord!.vendor_id).toBeNull();
            expect(latestRecord!.vendor_model_name).toBe("non-existent-model");
        }, 30000);

        it("should return 503 when no upstream is available", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: "vendor-not-found-model",
            });

            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            expect(response.status).toBe(503);
            expect(response.body).toEqual({
                error: {
                    message: expect.stringContaining("No available upstream"),
                    type: "api_error",
                    param: null,
                    code: "api_error"
                }
            });
        }, 30000);
    });

    describe("POST /llm/v1/messages (Anthropic)", () => {
        it("should return 401 when x-api-key header is missing", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
            });

            const response = await requestHelper.post(
                "/llm/v1/messages",
                messageRequest,
                undefined,
            );

            expect(response.status).toBe(401);
            expect(response.body).toEqual({
                type: "error",
                error: {
                    type: "authentication_error",
                    message: expect.stringContaining("x-api-key")
                }
            });
        }, 30000);

        it("should return 401 when token is invalid", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
            });

            const response = await requestHelper.postWithAnthropicStyleApiKey(
                "/llm/v1/messages",
                messageRequest,
                "invalid-token-12345",
            );

            expect(response.status).toBe(401);
            expect(response.body).toEqual({
                type: "error",
                error: {
                    type: "authentication_error",
                    message: expect.stringContaining("user not found")
                }
            });
        }, 30000);

        it("should return 403 when user is disabled", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
            });

            const response = await requestHelper.postWithAnthropicStyleApiKey(
                "/llm/v1/messages",
                messageRequest,
                disabledUserToken,
            );

            expect(response.status).toBe(403);
            expect(response.body).toEqual({
                type: "error",
                error: {
                    type: "authentication_error",
                    message: expect.stringContaining("User disabled")
                }
            });
        }, 30000);

        it("should use Anthropic error format for an invalid request body", async () => {
            const response = await requestHelper.request("/llm/v1/messages", {
                method: "POST",
                headers: { "x-api-key": testUserToken },
                body: "null",
            });

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                type: "error",
                error: {
                    type: "invalid_request_error",
                    message: "Request body must be a JSON object",
                },
            });
        }, 30000);

        it("should return 401 when model does not exist", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: "non-existent-model",
            });

            const response = await requestHelper.postWithAnthropicStyleApiKey(
                "/llm/v1/messages",
                messageRequest,
                testUserToken,
            );

            expect(response.status).toBe(404);
            expect(response.body).toEqual({
                type: "error",
                error: {
                    type: "not_found_error",
                    message: expect.stringContaining("model not found")
                }
            });

            // Verify a failed record was created in the database
            const records = dbHelper.query<any>("SELECT * FROM record ORDER BY id DESC LIMIT 1");
            const latestRecord = records[0];
            expect(latestRecord).toBeDefined();
            expect(latestRecord!.status).toBe("failed");
            expect(latestRecord!.failed_code).toBe("model_not_found");
            expect(latestRecord!.model_id).toBeNull();
            expect(latestRecord!.vendor_id).toBeNull();
            expect(latestRecord!.vendor_model_name).toBe("non-existent-model");
        }, 30000);

        it("should return 503 when no upstream is available", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: "vendor-not-found-model",
            });

            const response = await requestHelper.postWithAnthropicStyleApiKey(
                "/llm/v1/messages",
                messageRequest,
                testUserToken,
            );

            expect(response.status).toBe(503);
            expect(response.body).toEqual({
                type: "error",
                error: {
                    type: "api_error",
                    message: expect.stringContaining("No available upstream")
                }
            });
        }, 30000);
    });

    describe("POST /llm/v1/responses (Responses API)", () => {
        it("should return 404 when model does not exist", async () => {
            const responsesRequest = {
                model: "non-existent-model",
                messages: [{ role: "user", content: "Hello" }]
            };

            const response = await requestHelper.post(
                "/llm/v1/responses",
                responsesRequest,
                testUserToken,
            );

            expect(response.status).toBe(404);
            expect(response.body).toEqual({
                error: {
                    message: expect.stringContaining("model not found"),
                    type: "not_found_error",
                    param: null,
                    code: "not_found_error"
                }
            });

            // Verify a failed record was created in the database
            const records = dbHelper.query<any>("SELECT * FROM record ORDER BY id DESC LIMIT 1");
            const latestRecord = records[0];
            expect(latestRecord).toBeDefined();
            expect(latestRecord!.status).toBe("failed");
            expect(latestRecord!.failed_code).toBe("model_not_found");
            expect(latestRecord!.model_id).toBeNull();
            expect(latestRecord!.vendor_id).toBeNull();
            expect(latestRecord!.vendor_model_name).toBe("non-existent-model");
        }, 30000);

        it("should return 503 when no upstream is available", async () => {
            const responsesRequest = {
                model: "vendor-not-found-model",
                messages: [{ role: "user", content: "Hello" }]
            };

            const response = await requestHelper.post(
                "/llm/v1/responses",
                responsesRequest,
                testUserToken,
            );

            expect(response.status).toBe(503);
            expect(response.body).toEqual({
                error: {
                    message: expect.stringContaining("No available upstream"),
                    type: "api_error",
                    param: null,
                    code: "api_error"
                }
            });
        }, 30000);
    });
});
