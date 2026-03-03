import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import testHelpers from "../../testHelpers";

/**
 * Vendor Endpoint Positive Tests
 */

let createdVendorId: number;

describe("Vendor API (Positive)", () => {
    beforeAll(async () => {
        await testHelpers.truncateDatabase();
    });
    describe("POST /vendor/create.json", () => {
        it("should create an OpenAI vendor", async () => {
            const vendorData = vendorFixtures.VENDOR_FIXTURES.openai();
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("id");
            expect(response.body.name).toBe(vendorData.name);
            expect(response.body.type).toBe(vendorData.type);
            expect(response.body.token).toBe(vendorData.token);
            expect(response.body.url).toBe(vendorData.url);
            expect(response.body.api_format).toBe(vendorData.api_format);
            expect(response.body).toHaveProperty("created_at");
            expect(response.body).toHaveProperty("updated_at");

            createdVendorId = response.body.id;
        });

        it("should create an Anthropic vendor", async () => {
            const vendorData = vendorFixtures.VENDOR_FIXTURES.anthropic();
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBe(200);
            expect(response.body.api_format).toBe("anthropic");
            expect(response.body.name).toBe(vendorData.name);
        });

        it("should create a custom vendor", async () => {
            const vendorData = vendorFixtures.VENDOR_FIXTURES.custom;
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBe(200);
            expect(response.body.api_format).toBe("openai");
            expect(response.body.url).toContain("custom.com");
        });

        it("should create an Aliyun vendor", async () => {
            const vendorData = vendorFixtures.VENDOR_FIXTURES.aliyun;
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBe(200);
            expect(response.body.type).toBe("aliyun");
            expect(response.body.url).toContain("aliyuncs.com");
        });

        it("should create a DeepSeek vendor", async () => {
            const vendorData = vendorFixtures.VENDOR_FIXTURES.deepseek;
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBe(200);
            expect(response.body.type).toBe("deepseek");
            expect(response.body.url).toContain("deepseek.com");
        });

        it("should create a random vendor", async () => {
            const vendorData = vendorFixtures.createRandomVendor({
                name: "Random Test Vendor",
                api_format: "openai",
            });
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Random Test Vendor");
            expect(response.body.api_format).toBe("openai");
        });
    });

    describe("GET /vendor/list.json", () => {
        it("should return a list of vendors", async () => {
            const response = await requestHelper.get("/vendor/list.json");

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBeGreaterThan(0);
        });

        it("should return vendors with correct structure", async () => {
            const response = await requestHelper.get("/vendor/list.json");
            const vendor = response.body[0];

            expect(vendor).toHaveProperty("id");
            expect(vendor).toHaveProperty("type");
            expect(vendor).toHaveProperty("api_format");
            expect(vendor).toHaveProperty("name");
            expect(vendor).toHaveProperty("token");
            expect(vendor).toHaveProperty("url");
            expect(vendor).toHaveProperty("created_at");
            expect(vendor).toHaveProperty("updated_at");
        });

        it("should include different API formats", async () => {
            const response = await requestHelper.get("/vendor/list.json");

            const apiFormats = response.body.map((v: any) => v.api_format);
            expect(apiFormats).toContain("openai");
            expect(apiFormats).toContain("anthropic");
        });
    });

    describe("GET /vendor/:id", () => {
        it("should return a vendor by ID", async () => {
            const response = await requestHelper.get(
                `/vendor/${createdVendorId}`,
            );

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(createdVendorId);
            expect(response.body.api_format).toBe("openai");
            expect(response.body).toHaveProperty("name");
        });

        it("should return vendor with all fields", async () => {
            const response = await requestHelper.get(
                `/vendor/${createdVendorId}`,
            );

            expect(response.body).toHaveProperty("id");
            expect(response.body).toHaveProperty("type");
            expect(response.body).toHaveProperty("api_format");
            expect(response.body).toHaveProperty("name");
            expect(response.body).toHaveProperty("token");
            expect(response.body).toHaveProperty("url");
            expect(response.body).toHaveProperty("created_at");
            expect(response.body).toHaveProperty("updated_at");
        });
    });
});
