import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import testHelpers from "../../testHelpers";

/**
 * Vendor Endpoint Negative Tests
 */

let createdVendorId: number;
let adminToken: string;

describe("Vendor API (Negative)", () => {
    beforeAll(async () => {
        await testHelpers.truncate();
        adminToken = await testHelpers.setupAdminUser();
    });

    beforeEach(async () => {
        const vendorData = vendorFixtures.VENDOR_FIXTURES.openai();
        const response = await requestHelper.post(
            "/vendor/create.json",
            vendorData,
            adminToken,
        );
        createdVendorId = response.body.id;
    });

    describe("POST /vendor/create.json", () => {
        it("should return error when required fields are missing", async () => {
            const vendorData = {
                name: "Test Vendor",
                // Missing: type, token, url, api_format
            };
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when api_format is invalid", async () => {
            const vendorData = {
                type: "other",
                name: "Test Vendor",
                token: "test-token",
                url: "https://example.com",
                api_format: "invalid-format",
            };
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when type is missing", async () => {
            const vendorData = {
                name: "Test Vendor",
                token: "test-token",
                url: "https://example.com",
                api_format: "openai",
                // Missing: type
            };
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error when URL is missing", async () => {
            const vendorData = {
                type: "other",
                name: "Test Vendor",
                token: "test-token",
                api_format: "openai",
                // Missing: url
            };
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });
    });

    describe("GET /vendor/:id", () => {
        it("should return error for non-existent vendor ID", async () => {
            const response = await requestHelper.get("/vendor/99999");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid ID format", async () => {
            const response = await requestHelper.get("/vendor/invalid-id");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for negative ID", async () => {
            const response = await requestHelper.get("/vendor/-1");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for zero ID", async () => {
            const response = await requestHelper.get("/vendor/0");

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });

    describe("PUT /vendor/:id", () => {
        it("should return error for non-existent vendor ID", async () => {
            const updateData = { name: "Updated Name" };
            const response = await requestHelper.put(
                "/vendor/99999",
                updateData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for invalid api_format", async () => {
            const updateData = { api_format: "invalid-format" };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
        });

        it("should return error for invalid ID format", async () => {
            const updateData = { name: "Updated Name" };
            const response = await requestHelper.put(
                "/vendor/invalid-id",
                updateData,
            );

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for negative ID", async () => {
            const updateData = { name: "Updated Name" };
            const response = await requestHelper.put("/vendor/-1", updateData);

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });

        it("should return error for zero ID", async () => {
            const updateData = { name: "Updated Name" };
            const response = await requestHelper.put("/vendor/0", updateData);

            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.body).toHaveProperty("error");
        });
    });
});
