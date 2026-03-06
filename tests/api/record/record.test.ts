import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * Record Endpoint Tests
 */

let testUserId: number;
let testUserToken: string;
let testVendorId: number;
let testModelId: number;
let adminToken: string;

describe("Record API", () => {
    beforeAll(async () => {
        await dbHelper.truncate();

        adminToken = await setupAdminUser();

        // Create test user
        const user = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserId = user.body.id;
        testUserToken = user.body.token;

        // Create test vendor
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        testVendorId = vendor.body.id;

        // Create test model
        const model = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(testVendorId),
            adminToken,
        );
        testModelId = model.body.id;
    });

    describe("GET /record/list.json", () => {
        it("should return a list of records", async () => {
            const response = await requestHelper.get("/record/list.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
        });

        it("should return records with correct structure", async () => {
            const response = await requestHelper.get("/record/list.json", adminToken);

            for (const record of response.body) {
                expect(record).toHaveProperty("id");
                expect(record).toHaveProperty("user_id");
                expect(record).toHaveProperty("model_id");
                expect(record).toHaveProperty("request_data");
                expect(record).toHaveProperty("response_data");
                expect(record).toHaveProperty("status");
                expect(record).toHaveProperty("prompt_tokens");
                expect(record).toHaveProperty("output_tokens");
                expect(record).toHaveProperty("first_token_latency");
                expect(record).toHaveProperty("start_at");
                expect(record).toHaveProperty("end_at");
                expect(record).toHaveProperty("created_at");
                expect(record).toHaveProperty("updated_at");
            }
        });
    });

    describe("GET /record/latest.json", () => {
        it("should return latest records with default limit", async () => {
            const response = await requestHelper.get("/record/latest.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
        });

        it("should return latest records with specified limit", async () => {
            const response = await requestHelper.get(
                "/record/latest.json?limit=5",
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBeLessThanOrEqual(5);
        });

        it("should return records sorted by created_at descending", async () => {
            const response = await requestHelper.get(
                "/record/latest.json?limit=10",
                adminToken,
            );

            if (response.body.length > 1) {
                const timestamps = response.body.map((r: any) =>
                    new Date(r.created_at).getTime(),
                );

                for (let i = 1; i < timestamps.length; i++) {
                    expect(timestamps[i - 1]).toBeGreaterThanOrEqual(
                        timestamps[i],
                    );
                }
            }
        });
    });

    describe("GET /record/:id", () => {
        it("should return error for non-existent record ID initially", async () => {
            const response = await requestHelper.get("/record/99999");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid ID format", async () => {
            const response = await requestHelper.get("/record/invalid-id");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });

    describe("Record Statistics Fields", () => {
        let openaiVendorId: number;
        let openaiModelId: number;
        let openaiModelName: string;
        let anthropicVendorId: number;
        let anthropicModelId: number;
        let anthropicModelName: string;
        let config: any;

        beforeAll(async () => {
            config = await import("../../config");

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
            const upstreamConfig = config.default.getCurrentUpstreamConfig();
            openaiModelName = upstreamConfig.openai.model;
            anthropicModelName = upstreamConfig.anthropic.model;

            // Create OpenAI model
            const openaiModel = await requestHelper.post(
                "/model/create.json",
                modelFixtures.createRandomModel(openaiVendorId, openaiModelName),
                adminToken,
            );
            openaiModelId = openaiModel.body.id;

            // Create Anthropic model
            const anthropicModel = await requestHelper.post(
                "/model/create.json",
                modelFixtures.createRandomModel(anthropicVendorId, anthropicModelName),
                adminToken,
            );
            anthropicModelId = anthropicModel.body.id;
        });

        it("should create record with default statistics values after chat request", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );

            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);
            const record = recordsResponse.body[0];
            expect(record).toHaveProperty("prompt_tokens");
            expect(record).toHaveProperty("output_tokens");
            expect(record).toHaveProperty("first_token_latency");
            expect(record).toHaveProperty("start_at");
            expect(record).toHaveProperty("end_at");
        });

        it("should return record with statistics fields via API", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );

            const record = recordsResponse.body[0];
            const recordResponse = await requestHelper.get(
                `/record/${record.id}`,
                adminToken,
            );

            expect(recordResponse.status).toBe(200);
            expect(recordResponse.body).toHaveProperty("prompt_tokens");
            expect(recordResponse.body).toHaveProperty("output_tokens");
            expect(recordResponse.body).toHaveProperty("first_token_latency");
            expect(recordResponse.body).toHaveProperty("start_at");
            expect(recordResponse.body).toHaveProperty("end_at");
        });

        it("should include statistics in latest records endpoint", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=5",
                adminToken,
            );

            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);

            for (const record of recordsResponse.body) {
                expect(record).toHaveProperty("prompt_tokens");
                expect(record).toHaveProperty("output_tokens");
                expect(record).toHaveProperty("first_token_latency");
                expect(record).toHaveProperty("start_at");
                expect(record).toHaveProperty("end_at");
            }
        });

        it("should include statistics in list records endpoint", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/list.json",
                adminToken,
            );

            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);

            for (const record of recordsResponse.body) {
                expect(record).toHaveProperty("prompt_tokens");
                expect(record).toHaveProperty("output_tokens");
                expect(record).toHaveProperty("first_token_latency");
                expect(record).toHaveProperty("start_at");
                expect(record).toHaveProperty("end_at");
            }
        });

        it("should return correct statistics for successful requests", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: false,
            });

            await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );

            const record = recordsResponse.body[0];
            const recordResponse = await requestHelper.get(
                `/record/${record.id}`,
                adminToken,
            );

            expect(recordResponse.status).toBe(200);
            expect(recordResponse.body.status).toBe("success");
            expect(recordResponse.body.user_id).toBe(testUserId);
            expect(recordResponse.body.model_id).toBe(openaiModelId);

            // Verify token statistics are populated
            if (config.isRealMode) {
                expect(recordResponse.body.prompt_tokens).toBeGreaterThan(0);
                expect(recordResponse.body.output_tokens).toBeGreaterThan(0);
            } else {
                // mock server returns 10 prompt, 15 completion
                expect(recordResponse.body.prompt_tokens).toBe(10);
                expect(recordResponse.body.output_tokens).toBe(15);
            }

            // Verify timing fields
            expect(recordResponse.body.start_at).toBeTruthy();
            expect(recordResponse.body.end_at).toBeTruthy();

            // Verify end_at is after start_at
            const startTime = new Date(recordResponse.body.start_at).getTime();
            const endTime = new Date(recordResponse.body.end_at).getTime();
            expect(endTime).toBeGreaterThanOrEqual(startTime);
        });

        it("should populate statistics fields from streaming response", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: openaiModelName,
                stream: true,
            });

            await requestHelper.post(
                "/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );

            const record = recordsResponse.body[0];
            const recordResponse = await requestHelper.get(
                `/record/${record.id}`,
                adminToken,
            );

            expect(recordResponse.status).toBe(200);
            expect(recordResponse.body.status).toBe("success");
            expect(recordResponse.body.user_id).toBe(testUserId);
            expect(recordResponse.body.model_id).toBe(openaiModelId);

            // Verify token statistics for streaming
            if (config.isRealMode) {
                expect(recordResponse.body.prompt_tokens).toBeGreaterThan(0);
                expect(recordResponse.body.output_tokens).toBeGreaterThan(0);
            } else {
                // mock returns 8 prompt, 12 completion
                expect(recordResponse.body.prompt_tokens).toBe(8);
                expect(recordResponse.body.output_tokens).toBe(12);
            }

            // Verify first_token_latency is recorded (should be positive for streaming)
            expect(recordResponse.body.first_token_latency).toBeGreaterThan(0);

            // Verify timing fields
            expect(recordResponse.body.start_at).toBeTruthy();
            expect(recordResponse.body.end_at).toBeTruthy();
        });

        it("should return correct statistics for Anthropic non-streaming requests", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
                stream: false,
            });

            await requestHelper.post(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );

            const record = recordsResponse.body[0];
            const recordResponse = await requestHelper.get(
                `/record/${record.id}`,
                adminToken,
            );

            expect(recordResponse.status).toBe(200);
            expect(recordResponse.body.status).toBe("success");
            expect(recordResponse.body.user_id).toBe(testUserId);
            expect(recordResponse.body.model_id).toBe(anthropicModelId);

            // Verify token statistics
            if (config.isRealMode) {
                expect(recordResponse.body.prompt_tokens).toBeGreaterThan(0);
                expect(recordResponse.body.output_tokens).toBeGreaterThan(0);
            } else {
                // mock returns 10 input, 15 output
                expect(recordResponse.body.prompt_tokens).toBe(10);
                expect(recordResponse.body.output_tokens).toBe(15);
            }

            // Verify timing fields
            expect(recordResponse.body.start_at).toBeTruthy();
            expect(recordResponse.body.end_at).toBeTruthy();
        });

        it("should return correct statistics for Anthropic streaming requests", async () => {
            const messageRequest = mockHelper.generateAnthropicMessageRequest({
                model: anthropicModelName,
                stream: true,
            });

            await requestHelper.post(
                "/v1/messages",
                messageRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );

            const record = recordsResponse.body[0];
            const recordResponse = await requestHelper.get(
                `/record/${record.id}`,
                adminToken,
            );

            expect(recordResponse.status).toBe(200);
            expect(recordResponse.body.status).toBe("success");
            expect(recordResponse.body.user_id).toBe(testUserId);
            expect(recordResponse.body.model_id).toBe(anthropicModelId);

            // Verify token statistics for streaming
            if (config.isRealMode) {
                expect(recordResponse.body.prompt_tokens).toBeGreaterThan(0);
                expect(recordResponse.body.output_tokens).toBeGreaterThan(0);
            } else {
                // mock returns 8 input, 12 output
                expect(recordResponse.body.prompt_tokens).toBe(8);
                expect(recordResponse.body.output_tokens).toBe(12);
            }

            // Verify first_token_latency is recorded (should be positive for streaming)
            expect(recordResponse.body.first_token_latency).toBeGreaterThan(0);

            // Verify timing fields
            expect(recordResponse.body.start_at).toBeTruthy();
            expect(recordResponse.body.end_at).toBeTruthy();
        });
    });
});
