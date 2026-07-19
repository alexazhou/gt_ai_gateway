import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";

/**
 * Model Endpoint Negative Tests
 */

let existingVendorId: number;
let updateModelId: number;
let adminToken: string;

describe("Model API (Negative)", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        // Create a vendor for model tests
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        existingVendorId = vendor.body.id;

        // Create an existing model
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(existingVendorId, "duplicate-model"),
            adminToken,
        );

        // Create a model for update tests
        const updateModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(existingVendorId, "update-test-model"),
            adminToken,
        );
        updateModelId = updateModel.body.id;
    });

    describe("POST /model/create.json", () => {
        it("should return error when name is missing", async () => {
            const { name: _name, ...modelData } = modelFixtures.createRandomModel(existingVendorId);
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when routing config is missing", async () => {
            const modelData = {
                name: "test-model",
                enable: true,
                prices: {},
                routing_mode: "single",
            };
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when both required fields are missing", async () => {
            const modelData = {};
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when vendor_id does not exist", async () => {
            const modelData = modelFixtures.createRandomModel(99999, "test-model");
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });
    });

    describe("GET /model/:id", () => {
        it("should return error for non-existent model ID", async () => {
            const response = await requestHelper.get("/model/99999");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid ID format", async () => {
            const response = await requestHelper.get("/model/invalid-id");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for negative ID", async () => {
            const response = await requestHelper.get("/model/-1");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for zero ID", async () => {
            const response = await requestHelper.get("/model/0");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });

    describe("PUT /model/:id", () => {
        it("should return error for non-existent model ID", async () => {
            const response = await requestHelper.put(
                "/model/99999",
                { name: "updated-name" },
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid ID format", async () => {
            const response = await requestHelper.put(
                "/model/invalid-id",
                { name: "updated-name" },
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for negative ID", async () => {
            const response = await requestHelper.put(
                "/model/-1",
                { name: "updated-name" },
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for zero ID", async () => {
            const response = await requestHelper.put(
                "/model/0",
                { name: "updated-name" },
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error when routing vendor does not exist", async () => {
            const response = await requestHelper.put(
                `/model/${updateModelId}`,
                modelFixtures.createRandomModel(99999, "update-test-model"),
                adminToken,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });

    describe("DELETE /model/:id", () => {
        it("should return 404 for non-existent model ID", async () => {
            const response = await requestHelper.del("/model/99999", adminToken);

            expect(response.status).toBe(404);
            expect(response.body.error).toBe("Model not found");
        });

        it("should return error for invalid ID format", async () => {
            const response = await requestHelper.del("/model/invalid-id", adminToken);

            expect(response.status).toBe(400);
            expect(response.body.error).toBe("Invalid ID format");
        });

        it("should reject malformed numeric IDs without deleting the matching model", async () => {
            const response = await requestHelper.del(`/model/${existingModelId}abc`, adminToken);

            expect(response.status).toBe(400);
            expect(response.body.error).toBe("Invalid ID format");

            const modelResponse = await requestHelper.get(`/model/${existingModelId}`, adminToken);
            expect(modelResponse.status).toBe(200);
            expect(modelResponse.body.name).toBe(existingModelName);
        });
    });
});
