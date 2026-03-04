import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import testHelpers from "../../testHelpers";

/**
 * Vendor Endpoint Positive Tests
 */

let createdVendorId: number;
let adminToken: string;

describe("Vendor API (Positive)", () => {
    beforeAll(async () => {
        await testHelpers.truncate();
        adminToken = await testHelpers.setupAdminUser();
    });
    describe("POST /vendor/create.json", () => {
        it("should create an OpenAI vendor", async () => {
            const vendorData = vendorFixtures.VENDOR_FIXTURES.openai();
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
                adminToken,
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
                adminToken,
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
                adminToken,
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
                adminToken,
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
                adminToken,
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
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Random Test Vendor");
            expect(response.body.api_format).toBe("openai");
        });
    });

    describe("GET /vendor/list.json", () => {
        it("should return a list of vendors", async () => {
            const response = await requestHelper.get("/vendor/list.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBeGreaterThan(0);
        });

        it("should return vendors with correct structure", async () => {
            const response = await requestHelper.get("/vendor/list.json", adminToken);
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
            const response = await requestHelper.get("/vendor/list.json", adminToken);

            const apiFormats = response.body.map((v: any) => v.api_format);
            expect(apiFormats).toContain("openai");
            expect(apiFormats).toContain("anthropic");
        });
    });

    describe("GET /vendor/:id", () => {
        it("should return a vendor by ID", async () => {
            const response = await requestHelper.get(
                `/vendor/${createdVendorId}`,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(createdVendorId);
            expect(response.body.api_format).toBe("openai");
            expect(response.body).toHaveProperty("name");
        });

        it("should return vendor with all fields", async () => {
            const response = await requestHelper.get(
                `/vendor/${createdVendorId}`,
                adminToken,
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

    describe("PUT /vendor/:id", () => {
        it("should update vendor name", async () => {
            const updateData = { name: "Updated Vendor Name" };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(createdVendorId);
            expect(response.body.name).toBe("Updated Vendor Name");
        });

        it("should update vendor token", async () => {
            const updateData = { token: "new-updated-token" };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.token).toBe("new-updated-token");
        });

        it("should update vendor url", async () => {
            const updateData = {
                url: "https://updated-api.example.com/v1/chat",
            };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.url).toBe(
                "https://updated-api.example.com/v1/chat",
            );
        });

        it("should update vendor type", async () => {
            const updateData = { type: "deepseek" };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.type).toBe("deepseek");
        });

        it("should update vendor api_format", async () => {
            const updateData = { api_format: "anthropic" };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.api_format).toBe("anthropic");
        });

        it("should update multiple fields at once", async () => {
            const updateData = {
                name: "Multi-Updated Vendor",
                type: "aliyun",
                api_format: "openai",
            };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Multi-Updated Vendor");
            expect(response.body.type).toBe("aliyun");
            expect(response.body.api_format).toBe("openai");
        });

        it("should preserve unchanged fields", async () => {
            const getResponse = await requestHelper.get(
                `/vendor/${createdVendorId}`,
                adminToken,
            );
            const originalUrl = getResponse.body.url;
            const originalToken = getResponse.body.token;

            const updateData = { name: "Name Change Only" };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Name Change Only");
            expect(response.body.url).toBe(originalUrl);
            expect(response.body.token).toBe(originalToken);
        });
    });
});
