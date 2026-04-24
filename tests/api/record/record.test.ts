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
        it("should return a list of records with total count", async () => {
            const response = await requestHelper.get("/record/list.json", adminToken);

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("list");
            expect(response.body).toHaveProperty("total");
            expect(Array.isArray(response.body.list)).toBe(true);
        });

        it("should return records with correct structure", async () => {
            const response = await requestHelper.get("/record/list.json", adminToken);

            for (const record of response.body.list) {
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

    describe("GET /record/list.json - Filtering", () => {
        let userAId: number;
        let userAToken: string;
        let userBId: number;
        let userBToken: string;
        let modelAId: number;
        let modelBId: number;
        let filterVendorId: number;
        let modelAName: string;
        let modelBName: string;

        beforeAll(async () => {
            // 使用随机名称避免与其他测试的模型名冲突（modelService.getModel 按名字查找取第一条）
            const ts = Date.now();
            modelAName = `filter-model-a-${ts}`;
            modelBName = `filter-model-b-${ts}`;

            const vendor = await requestHelper.post(
                "/vendor/create.json",
                vendorFixtures.VENDOR_FIXTURES.openai(),
                adminToken,
            );
            filterVendorId = vendor.body.id;

            const [userA, userB, modelA, modelB] = await Promise.all([
                requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken),
                requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken),
                requestHelper.post("/model/create.json", modelFixtures.createRandomModel(filterVendorId, modelAName), adminToken),
                requestHelper.post("/model/create.json", modelFixtures.createRandomModel(filterVendorId, modelBName), adminToken),
            ]);
            userAId = userA.body.id;
            userAToken = userA.body.token;
            userBId = userB.body.id;
            userBToken = userB.body.token;
            modelAId = modelA.body.id;
            modelBId = modelB.body.id;

            // userA × modelA: 2 requests
            await requestHelper.post("/llm/v1/chat/completions", mockHelper.generateOpenAIChatRequest({ model: modelAName, stream: false }), userAToken);
            await requestHelper.post("/llm/v1/chat/completions", mockHelper.generateOpenAIChatRequest({ model: modelAName, stream: false }), userAToken);
            // userA × modelB: 1 request
            await requestHelper.post("/llm/v1/chat/completions", mockHelper.generateOpenAIChatRequest({ model: modelBName, stream: false }), userAToken);
            // userB × modelA: 1 request
            await requestHelper.post("/llm/v1/chat/completions", mockHelper.generateOpenAIChatRequest({ model: modelAName, stream: false }), userBToken);
        });

        it("should filter by single user_id", async () => {
            const res = await requestHelper.get(`/record/list.json?user_ids=${userAId}`, adminToken);

            expect(res.status).toBe(200);
            expect(res.body.list.every((r: any) => r.user_id === userAId)).toBe(true);
            expect(res.body.total).toBe(3);
        });

        it("should filter by multiple user_ids", async () => {
            const res = await requestHelper.get(`/record/list.json?user_ids=${userAId},${userBId}`, adminToken);

            expect(res.status).toBe(200);
            expect(res.body.list.every((r: any) => [userAId, userBId].includes(r.user_id))).toBe(true);
            expect(res.body.total).toBe(4);
        });

        it("should filter by single model_id", async () => {
            const res = await requestHelper.get(`/record/list.json?model_ids=${modelAId}`, adminToken);

            expect(res.status).toBe(200);
            expect(res.body.list.every((r: any) => r.model_id === modelAId)).toBe(true);
            expect(res.body.total).toBe(3);
        });

        it("should filter by multiple model_ids", async () => {
            const res = await requestHelper.get(`/record/list.json?model_ids=${modelAId},${modelBId}`, adminToken);

            expect(res.status).toBe(200);
            expect(res.body.list.every((r: any) => [modelAId, modelBId].includes(r.model_id))).toBe(true);
            expect(res.body.total).toBe(4);
        });

        it("should filter by user_id and model_id combined", async () => {
            const res = await requestHelper.get(`/record/list.json?user_ids=${userAId}&model_ids=${modelAId}`, adminToken);

            expect(res.status).toBe(200);
            expect(res.body.list.every((r: any) => r.user_id === userAId && r.model_id === modelAId)).toBe(true);
            expect(res.body.total).toBe(2);
        });

        it("should filter by status", async () => {
            const res = await requestHelper.get("/record/list.json?status=success", adminToken);

            expect(res.status).toBe(200);
            expect(res.body.list.every((r: any) => r.status === "success")).toBe(true);
        });

        it("should return empty list when no records match the filter", async () => {
            const res = await requestHelper.get("/record/list.json?user_ids=99999", adminToken);

            expect(res.status).toBe(200);
            expect(res.body.list).toHaveLength(0);
            expect(res.body.total).toBe(0);
        });

        it("should filter by start_time and end_time", async () => {
            // 使用远未来时间作为 start_time，应返回空
            const futureStart = "2099-01-01 00:00:00";
            const emptyRes = await requestHelper.get(
                `/record/list.json?start_time=${encodeURIComponent(futureStart)}`,
                adminToken,
            );
            expect(emptyRes.status).toBe(200);
            expect(emptyRes.body.total).toBe(0);

            // 使用远过去时间作为 start_time，应返回所有记录
            const pastStart = "2000-01-01 00:00:00";
            const allRes = await requestHelper.get(
                `/record/list.json?start_time=${encodeURIComponent(pastStart)}`,
                adminToken,
            );
            expect(allRes.status).toBe(200);
            expect(allRes.body.total).toBeGreaterThan(0);
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
                "/llm/v1/chat/completions",
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
                "/llm/v1/chat/completions",
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
                "/llm/v1/chat/completions",
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
                "/llm/v1/chat/completions",
                chatRequest,
                testUserToken,
            );

            const recordsResponse = await requestHelper.get(
                "/record/list.json",
                adminToken,
            );

            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.list.length).toBeGreaterThan(0);

            for (const record of recordsResponse.body.list) {
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
                "/llm/v1/chat/completions",
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
                "/llm/v1/chat/completions",
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
                "/llm/v1/messages",
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
                "/llm/v1/messages",
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
