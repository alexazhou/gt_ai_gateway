import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import testHelpers from "../../testHelpers";
import config from "../../config";

/**
 * AI Messages Endpoint Tests (Anthropic)
 */

let testUserId: number;
let testUserToken: string;
let anthropicVendorId: number;
let anthropicModelId: number;
let anthropicModelName: string;
let adminToken: string;

describe("AI Messages API (Anthropic)", () => {
    beforeAll(async () => {
        await testHelpers.truncate();

        adminToken = await testHelpers.setupAdminUser();

        // Create test user
        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserId = userResponse.body.id;
        testUserToken = userResponse.body.token;

        // Create Anthropic vendor
        const anthropicVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.anthropic(),
            adminToken,
        );
        console.log("Created vendor:", anthropicVendor.body);
        anthropicVendorId = anthropicVendor.body.id;

        // Get model name from config
        const upstreamConfig = config.getCurrentUpstreamConfig();
        anthropicModelName = upstreamConfig.anthropic.model;

        // Create Anthropic model
        const anthropicModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                anthropicVendorId,
                anthropicModelName,
            ),
            adminToken,
        );
        console.log("Created model:", anthropicModel.body);
        anthropicModelId = anthropicModel.body.id;

        // Verify vendor creation
        const vendorGet = await requestHelper.get(
            `/vendor/${anthropicVendorId}`,
            adminToken,
        );
        console.log("Retrieved vendor:", vendorGet.body);
    });

    describe("POST /v1/messages", () => {
        it("should handle successful Anthropic message request with x-api-key", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
                stream: false,
            });

            const response = await requestHelper.postWithApiKey(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            if (response.status !== 200) {
                console.log("ERROR body:", response.body);
            }

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("id");
            expect(response.body).toHaveProperty("type");
            expect(response.body.type).toBe("message");
            expect(response.body).toHaveProperty("role");
            expect(response.body.role).toBe("assistant");
            expect(response.body).toHaveProperty("content");
            expect(Array.isArray(response.body.content)).toBe(true);
            expect(response.body.content[0]).toHaveProperty("text");
            expect(response.body).toHaveProperty("model");
            expect(response.body).toHaveProperty("stop_reason");
            expect(response.body).toHaveProperty("usage");

            // Verify record was created
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);
            const latestRecord = recordsResponse.body[0];
            expect(latestRecord.user_id).toBe(testUserId);
            expect(latestRecord.model_id).toBe(anthropicModelId);
            expect(latestRecord.status).toBe("success");

            // Verify request_data contains sent request
            const requestData = JSON.parse(latestRecord.request_data);
            expect(requestData).toHaveProperty("model");
            expect(requestData).toHaveProperty("messages");
            expect(requestData.model).toBe(anthropicModelName);

            // Verify response_data contains received response
            const responseData = JSON.parse(latestRecord.response_data);
            expect(responseData).toHaveProperty("id");
            expect(responseData).toHaveProperty("type");
            expect(responseData.type).toBe("message");
            expect(responseData).toHaveProperty("content");
            expect(responseData.content[0].text).toBe(
                response.body.content[0].text,
            );
        }, 30000);

        it("should handle successful Anthropic message request with Authorization header", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
                stream: false,
            });

            const response = await requestHelper.post(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.type).toBe("message");
            expect(response.body.role).toBe("assistant");
        }, 30000);

        it("should handle streaming Anthropic message request", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
                stream: true,
            });

            const response = await requestHelper.postWithApiKey(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(typeof response.body).toBe("string");
            expect(response.body).toContain("event:");
            expect(response.body).toContain("message_start");
            expect(response.body).toContain("content_block_delta");
            expect(response.body).toContain("message_stop");

            // Verify record was created for streaming request
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);
            const latestRecord = recordsResponse.body[0];
            expect(latestRecord.user_id).toBe(testUserId);
            expect(latestRecord.model_id).toBe(anthropicModelId);
            expect(latestRecord.status).toBe("success");

            // Verify request_data contains streaming flag
            const requestData = JSON.parse(latestRecord.request_data);
            expect(requestData.stream).toBe(true);

            // Verify response_data contains streaming response (stored as JSON string of last chunk)
            const responseData = latestRecord.response_data;
            expect(typeof responseData).toBe("string");
            const parsedResponseData = JSON.parse(responseData);
            expect(parsedResponseData).toHaveProperty("choices");
            expect(Array.isArray(parsedResponseData.choices)).toBe(true);
        }, 30000);

        it("should handle multiple messages in request", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
                stream: false,
                messages: [
                    { role: "user", content: "Hello!" },
                    { role: "assistant", content: "Hi there!" },
                    { role: "user", content: "How are you?" },
                ],
            });

            const response = await requestHelper.postWithApiKey(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.type).toBe("message");
            expect(response.body.role).toBe("assistant");
        }, 30000);

        it("should handle custom max_tokens value", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
                stream: false,
                max_tokens: 512,
            });

            const response = await requestHelper.postWithApiKey(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.type).toBe("message");
        }, 30000);
    });
});
