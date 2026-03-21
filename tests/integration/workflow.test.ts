import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../helpers/requestHelper";
import mockHelper from "../helpers/mockHelper";
import vendorFixtures from "../fixtures/vendorFixtures";
import modelFixtures from "../fixtures/modelFixtures";
import testHelpers from "../testHelpers";
import dbHelper from "../helpers/dbHelper"
import { setupAdminUser } from "../globalSetup";

/**
 * Integration Tests - Complete Workflows
 */

let adminToken: string;

describe("Integration Tests", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
    });

    describe("Complete User -> Vendor -> Model -> Request Workflow", () => {
        let userId: number;
        let userToken: string;
        let vendorId: number;
        let modelId: number;
        let modelName: string;

        it("should complete full workflow: create vendor, model, user, and make request", async () => {
            // Step 1: Create a vendor
            const vendorResponse = await requestHelper.post(
                "/vendor/create.json",
                vendorFixtures.VENDOR_FIXTURES.openai(),
                adminToken,
            );
            expect(vendorResponse.status).toBe(200);
            vendorId = vendorResponse.body.id;
            expect(vendorId).toBeGreaterThan(0);

            // Step 2: Create a model linked to the vendor
            const modelNameValue = "integration-test-model";
            const modelResponse = await requestHelper.post(
                "/model/create.json",
                modelFixtures.createRandomModel(vendorId, modelNameValue),
                adminToken,
            );
            expect(modelResponse.status).toBe(200);
            modelId = modelResponse.body.id;
            modelName = modelResponse.body.name;
            expect(modelId).toBeGreaterThan(0);
            expect(modelName).toBe(modelNameValue);

            // Step 3: Create a user
            const userResponse = await requestHelper.post(
                "/user/create.json",
                mockHelper.generateUser(),
                adminToken,
            );
            expect(userResponse.status).toBe(200);
            userId = userResponse.body.id;
            userToken = userResponse.body.token;
            expect(userId).toBeGreaterThan(0);
            expect(userToken).toBeTruthy();

            // Step 4: Make an AI request
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: modelName,
                stream: false,
            });
            const chatResponse = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                userToken,
            );
            expect(chatResponse.status).toBe(200);
            expect(chatResponse.body.choices[0].message.content).toBeTruthy();

            // Step 5: Verify records were created
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=1",
                adminToken,
            );
            expect(recordsResponse.status).toBe(200);
            expect(recordsResponse.body.length).toBeGreaterThan(0);

            const latestRecord = recordsResponse.body[0];
            expect(latestRecord.user_id).toBe(userId);
            expect(latestRecord.model_id).toBe(modelId);
        }, 60000);

        it("should verify cross-data associations in record", async () => {
            const recordsResponse = await requestHelper.get(
                "/record/latest.json?limit=10",
                adminToken,
            );
            const record = recordsResponse.body.find(
                (r: any) => r.user_id === userId && r.model_id === modelId,
            );

            expect(record).toBeDefined();
            expect(record.user_id).toBe(userId);
            expect(record.model_id).toBe(modelId);

            // Verify user exists
            const userResponse = await requestHelper.get(`/user/${userId}`, adminToken);
            expect(userResponse.status).toBe(200);
            expect(userResponse.body.id).toBe(userId);

            // Verify model exists
            const modelsResponse = await requestHelper.get("/model/list.json", adminToken);
            const model = modelsResponse.body.list.find(
                (m: any) => m.id === modelId,
            );
            expect(model).toBeDefined();
            expect(model.name).toBe(modelName);

            // Verify vendor exists
            const vendorResponse = await requestHelper.get(
                `/vendor/${vendorId}`,
                adminToken,
            );
            expect(vendorResponse.status).toBe(200);
            expect(vendorResponse.body.id).toBe(vendorId);
        }, 60000);

        it("should handle multiple requests from same user to same model", async () => {
            const chatRequest = mockHelper.generateOpenAIChatRequest({
                model: modelName,
                stream: false,
            });

            // Make multiple requests
            const response1 = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                userToken,
            );
            const response2 = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                userToken,
            );
            const response3 = await requestHelper.post(
                "/llm/v1/chat/completions",
                chatRequest,
                userToken,
            );

            expect(response1.status).toBe(200);
            expect(response2.status).toBe(200);
            expect(response3.status).toBe(200);

            // Verify records count increased
            const recordsResponse =
                await requestHelper.get("/record/list.json", adminToken);
            const userRecords = recordsResponse.body.list.filter(
                (r: any) => r.user_id === userId && r.model_id === modelId,
            );

            expect(userRecords.length).toBeGreaterThanOrEqual(3);
        }, 60000);
    });

    describe("Multi-User, Multi-Model Workflow", () => {
        let users: Array<{ id: number; token: string }> = [];
        let models: Array<{ id: number; name: string }> = [];

        it("should create multiple users and models", async () => {
            const vendorResponse = await requestHelper.post(
                "/vendor/create.json",
                vendorFixtures.VENDOR_FIXTURES.openai(),
                adminToken,
            );
            const vendorId = vendorResponse.body.id;

            // Create 3 users
            for (let i = 0; i < 3; i++) {
                const userResponse = await requestHelper.post(
                    "/user/create.json",
                    mockHelper.generateUser(),
                    adminToken,
                );
                expect(userResponse.status).toBe(200);
                users.push({
                    id: userResponse.body.id,
                    token: userResponse.body.token,
                });
            }

            // Create 3 models
            for (let i = 0; i < 3; i++) {
                const modelResponse = await requestHelper.post(
                    "/model/create.json",
                    modelFixtures.createRandomModel(
                        vendorId,
                        `multi-model-${i}`,
                    ),
                    adminToken,
                );
                expect(modelResponse.status).toBe(200);
                models.push({
                    id: modelResponse.body.id,
                    name: modelResponse.body.name,
                });
            }

            expect(users.length).toBe(3);
            expect(models.length).toBe(3);
        }, 60000);

        it("should verify each user can access each model", async () => {
            for (const user of users) {
                for (const model of models) {
                    const chatRequest = mockHelper.generateOpenAIChatRequest({
                        model: model.name,
                        stream: false,
                    });
                    const response = await requestHelper.post(
                        "/llm/v1/chat/completions",
                        chatRequest,
                        user.token,
                    );

                    expect(response.status).toBe(200);
                    expect(
                        response.body.choices[0].message.content,
                    ).toBeTruthy();
                }
            }
        }, 120000);

        it("should verify records correctly track user-model combinations", async () => {
            const recordsResponse =
                await requestHelper.get("/record/list.json", adminToken);

            // Count unique user-model combinations
            const combinations = new Set<string>();
            for (const record of recordsResponse.body.list) {
                combinations.add(`${record.user_id}-${record.model_id}`);
            }

            // We should have at least 9 combinations (3 users x 3 models)
            expect(combinations.size).toBeGreaterThanOrEqual(9);
        }, 60000);
    });
});
