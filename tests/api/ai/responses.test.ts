import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * OpenAI Responses API Endpoint Tests
 */

let testUserId: number;
let testUserToken: string;
let responsesVendorId: number;
let responsesModelId: number;
let responsesModelName: string;
let adminToken: string;

describe("AI Responses API", () => {
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

        // 使用 base URL（不含 /chat/completions），让网关自动拼接 /responses
        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;
        const vendorResponse = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Vendor",
                token: "mock-responses-token",
                urls: { openai: mockBaseUrl },
            },
            adminToken,
        );
        responsesVendorId = vendorResponse.body.id;

        responsesModelName = "gpt-4o";
        const modelResponse = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(responsesVendorId, responsesModelName),
            adminToken,
        );
        responsesModelId = modelResponse.body.id;
    });

    describe("POST /llm/v1/responses", () => {
        it("should handle non-streaming responses request", async () => {
            const req = mockHelper.generateResponsesRequest({
                model: responsesModelName,
                stream: false,
            });

            const response = await requestHelper.post(
                "/llm/v1/responses",
                req,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.object).toBe("response");
            expect(response.body.status).toBe("completed");
            expect(Array.isArray(response.body.output)).toBe(true);
            expect(response.body.output[0].role).toBe("assistant");
            expect(response.body.output[0].content[0].type).toBe("output_text");
            expect(response.body.output[0].content[0].text.length).toBeGreaterThan(0);
            expect(response.body.usage.input_tokens).toBeGreaterThan(0);
            expect(response.body.usage.output_tokens).toBeGreaterThan(0);

            // 验证 record 已创建
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            const record = recordsResponse.body[0];
            expect(record.user_id).toBe(testUserId);
            expect(record.model_id).toBe(responsesModelId);
            expect(record.status).toBe("success");
            expect(record.prompt_tokens).toBeGreaterThan(0);
            expect(record.output_tokens).toBeGreaterThan(0);
        }, 30000);

        it("should handle streaming responses request", async () => {
            const req = mockHelper.generateResponsesRequest({
                model: responsesModelName,
                stream: true,
            });

            const response = await requestHelper.post(
                "/llm/v1/responses",
                req,
                testUserToken,
            );

            expect(response.status).toBe(200);
            expect(typeof response.body).toBe("string");
            expect(response.body).toContain("response.created");
            expect(response.body).toContain("response.output_text.delta");
            expect(response.body).toContain("response.completed");

            // 验证 record 已创建且 usage 正确
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            const record = recordsResponse.body[0];
            expect(record.user_id).toBe(testUserId);
            expect(record.model_id).toBe(responsesModelId);
            expect(record.status).toBe("success");
            expect(record.prompt_tokens).toBeGreaterThan(0);
            expect(record.output_tokens).toBeGreaterThan(0);
        }, 30000);
    });
});
