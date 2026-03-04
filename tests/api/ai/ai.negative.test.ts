import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import testHelpers from "../../testHelpers";
import config from "../../config";

/**
 * AI Endpoint Negative Tests
 */

let testUserToken: string;
let openaiVendorId: number;
let anthropicVendorId: number;
let openaiModelName: string;
let anthropicModelName: string;
let adminToken: string;

describe("AI Chat API (Negative)", () => {
    beforeAll(async () => {
        await testHelpers.truncate();

        adminToken = await testHelpers.setupAdminUser();

        // Create test user
        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
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
    });

    describe("POST /v1/chat/completions", () => {
        it("should return 401 when Authorization header is missing", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
            });

            const response = await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                undefined,
            );

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty("error");
            expect(response.body.error).toContain("Authorization");
        }, 30000);

        it("should return 401 when token is invalid", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
            });

            const response = await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                "invalid-token-12345",
            );

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty("error");
            expect(response.body.error).toContain("user not found");
        }, 30000);

        it("should return 401 when model does not exist", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: "non-existent-model",
            });

            const response = await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty("error");
            expect(response.body.error).toContain("model not found");
        }, 30000);
    });

    describe("POST /v1/messages (Anthropic)", () => {
        it("should return 401 when x-api-key header is missing", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
            });

            const response = await requestHelper.post(
                "/v1/messages",
                messageRequest,
                undefined,
            );

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty("error");
            expect(response.body.error).toContain("x-api-key");
        }, 30000);

        it("should return 401 when token is invalid", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
            });

            const response = await requestHelper.postWithApiKey(
                "/v1/messages",
                messageRequest,
                "invalid-token-12345",
            );

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty("error");
            expect(response.body.error).toContain("user not found");
        }, 30000);

        it("should return 401 when model does not exist", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: "non-existent-model",
            });

            const response = await requestHelper.postWithApiKey(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty("error");
            expect(response.body.error).toContain("model not found");
        }, 30000);
    });
});
