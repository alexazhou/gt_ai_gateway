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

describe("Model API (Negative)", () => {
    beforeAll(async () => {
        await testHelpers.truncateDatabase();

        // Create a vendor for model tests
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
        );
        existingVendorId = vendor.body.id;

        // Create an existing model
        const model = await requestHelper.post("/model/create.json", {
            name: "duplicate-model",
            vendor_id: existingVendorId,
        });
        existingModelId = model.body.id;
        existingModelName = "duplicate-model";
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
});
