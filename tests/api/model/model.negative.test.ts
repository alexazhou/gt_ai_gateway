import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import testHelpers from "../../testHelpers";

/**
 * Model Endpoint Negative Tests
 */

let existingModelId: number;
let existingModelName: string;
let existingVendorId: number;
let updateModelId: number;
let adminToken: string;

describe("Model API (Negative)", () => {
    beforeAll(async () => {
        await testHelpers.truncate();
        adminToken = await testHelpers.setupAdminUser();

        // Create a vendor for model tests
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        existingVendorId = vendor.body.id;

        // Create an existing model
        const model = await requestHelper.post("/model/create.json", {
            name: "duplicate-model",
            vendor_id: existingVendorId,
        }, adminToken);
        existingModelId = model.body.id;
        existingModelName = "duplicate-model";

        // Create a model for update tests
        const updateModel = await requestHelper.post("/model/create.json", {
            name: "update-test-model",
            vendor_id: existingVendorId,
        }, adminToken);
        updateModelId = updateModel.body.id;
    });

    describe("POST /model/create.json", () => {
        it("should return error when name is missing", async () => {
            const modelData = {
                vendor_id: existingVendorId,
            };
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when vendor_id is missing", async () => {
            const modelData = {
                name: "test-model",
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
            const modelData = {
                name: "test-model",
                vendor_id: 99999,
            };
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

        it("should return error when vendor_id does not exist", async () => {
            const response = await requestHelper.put(
                `/model/${updateModelId}`,
                { vendor_id: 99999 },
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });
});
