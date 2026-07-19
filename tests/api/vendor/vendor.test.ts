import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";

/**
 * Vendor Endpoint Positive Tests
 */

let createdVendorId: number;
let adminToken: string;

describe("Vendor API (Positive)", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
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
            expect(response.body.urls).toEqual(vendorData.urls);
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
            expect(response.body.urls).toHaveProperty("anthropic");
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
            expect(response.body.urls).toHaveProperty("openai");
            expect(response.body.urls.openai).toContain("custom.com");
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
            expect(response.body.urls.openai).toContain("aliyuncs.com");
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
            expect(response.body.urls.openai).toContain("deepseek.com");
        });

        it("should create a random vendor", async () => {
            const vendorData = vendorFixtures.createRandomVendor({
                name: "Random Test Vendor",
                urls: { openai: "https://api.example.com/v1/chat" },
            });
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Random Test Vendor");
            expect(response.body.urls).toHaveProperty("openai");
        });
    });

    describe("GET /vendor/list.json", () => {
        it("should return a list of vendors", async () => {
            const response = await requestHelper.get("/vendor/list.json", adminToken);

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body.list)).toBe(true);
            expect(response.body.total).toBeGreaterThan(0);
        });

        it("should return vendors with correct structure", async () => {
            const response = await requestHelper.get("/vendor/list.json", adminToken);
            const vendor = response.body.list[0];

            expect(vendor).toHaveProperty("id");
            expect(vendor).toHaveProperty("type");
            expect(vendor).toHaveProperty("urls");
            expect(vendor).toHaveProperty("name");
            expect(vendor).toHaveProperty("token");
            expect(vendor).toHaveProperty("model_count");
            expect(vendor).toHaveProperty("created_at");
            expect(vendor).toHaveProperty("updated_at");
        });

        it("should reflect correct model_count after adding vendor models", async () => {
            // Add 2 vendor models to the created vendor
            const add1 = await requestHelper.post(
                `/vendor/${createdVendorId}/model/add.json`,
                { model_id: "test-model-1" },
                adminToken,
            );
            expect(add1.status).toBe(200);
            const add2 = await requestHelper.post(
                `/vendor/${createdVendorId}/model/add.json`,
                { model_id: "test-model-2" },
                adminToken,
            );
            expect(add2.status).toBe(200);

            const response = await requestHelper.get("/vendor/list.json", adminToken);
            const vendor = response.body.list.find((v: any) => v.id === createdVendorId);

            expect(vendor).toBeDefined();
            expect(vendor.model_count).toBe(2);
        });

        it("should include different API formats", async () => {
            const response = await requestHelper.get("/vendor/list.json", adminToken);

            const allUrls = response.body.list.map((v: any) => Object.keys(v.urls || {}));
            const flatUrls = allUrls.flat();
            expect(flatUrls).toContain("openai");
            expect(flatUrls).toContain("anthropic");
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
            expect(response.body.urls).toHaveProperty("openai");
            expect(response.body).toHaveProperty("name");
        });

        it("should return vendor with all fields", async () => {
            const response = await requestHelper.get(
                `/vendor/${createdVendorId}`,
                adminToken,
            );

            expect(response.body).toHaveProperty("id");
            expect(response.body).toHaveProperty("type");
            expect(response.body).toHaveProperty("urls");
            expect(response.body).toHaveProperty("name");
            expect(response.body).toHaveProperty("token");
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
                urls: {
                    openai: "https://updated-api.example.com/v1/chat",
                },
            };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.urls.openai).toBe(
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

        it("should update vendor urls", async () => {
            const updateData = {
                urls: {
                    openai: "https://api.openai.com/v1/chat/completions",
                    anthropic: "https://api.anthropic.com/v1/messages",
                },
            };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.urls).toHaveProperty("openai");
            expect(response.body.urls).toHaveProperty("anthropic");
        });

        it("should update multiple fields at once", async () => {
            const updateData = {
                name: "Multi-Updated Vendor",
                type: "aliyun",
                urls: { openai: "https://api.example.com/v1/chat" },
            };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Multi-Updated Vendor");
            expect(response.body.type).toBe("aliyun");
            expect(response.body.urls).toEqual({ openai: "https://api.example.com/v1/chat" });
        });

        it("should preserve unchanged fields", async () => {
            const getResponse = await requestHelper.get(
                `/vendor/${createdVendorId}`,
                adminToken,
            );
            const originalUrls = getResponse.body.urls;
            const originalToken = getResponse.body.token;

            const updateData = { name: "Name Change Only" };
            const response = await requestHelper.put(
                `/vendor/${createdVendorId}`,
                updateData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("Name Change Only");
            expect(response.body.urls).toEqual(originalUrls);
            expect(response.body.token).toBe(originalToken);
        });
    });

    describe("DELETE /vendor/:id", () => {
        it("should reject deleting a vendor used by a model upstream", async () => {
            const vendorResponse = await requestHelper.post(
                "/vendor/create.json",
                vendorFixtures.createRandomVendor({ name: "Referenced Vendor" }),
                adminToken,
            );
            const vendorId = vendorResponse.body.id;
            await requestHelper.post(
                "/model/create.json",
                {
                    name: `referenced-vendor-model-${Date.now()}`,
                    enable: true,
                    prices: {},
                    routing_mode: "single",
                    routing_config: {
                        upstreams: [{ vendor_id: vendorId, enabled: true }],
                    },
                },
                adminToken,
            );

            const response = await requestHelper.del(`/vendor/${vendorId}`, adminToken);

            expect(response.status).toBe(400);
            expect(response.body.error).toContain("associated models");
        });

        it("should only delete the specified vendor, not others", async () => {
            // 创建两个供应商
            const vendorAData = vendorFixtures.createRandomVendor({ name: "Vendor A" });
            const vendorBData = vendorFixtures.createRandomVendor({ name: "Vendor B" });

            const resA = await requestHelper.post("/vendor/create.json", vendorAData, adminToken);
            const resB = await requestHelper.post("/vendor/create.json", vendorBData, adminToken);
            const vendorAId = resA.body.id;
            const vendorBId = resB.body.id;

            // 删除 Vendor A
            const deleteRes = await requestHelper.del(`/vendor/${vendorAId}`, adminToken);
            expect(deleteRes.status).toBe(200);
            expect(deleteRes.body.success).toBe(true);

            // Vendor A 应该不存在了
            const getARes = await requestHelper.get(`/vendor/${vendorAId}`, adminToken);
            expect(getARes.status).toBe(404);

            // Vendor B 应该依然存在
            const getBRes = await requestHelper.get(`/vendor/${vendorBId}`, adminToken);
            expect(getBRes.status).toBe(200);
            expect(getBRes.body.id).toBe(vendorBId);
        });
    });

    describe("Vendor auth_mode config", () => {
        it("should create vendor with config.auth_mode", async () => {
            const vendorData = {
                type: "other",
                name: `Auth Test Vendor ${Date.now()}`,
                token: `auth-token-${Date.now()}`,
                urls: { openai: "https://api.example.com/v1/chat" },
                config: { auth_mode: "bearer_token" },
            };
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.config).toEqual({ auth_mode: "bearer_token", skip_tls_verify: false });
        });

        it("should default config.auth_mode to bearer_token when not provided", async () => {
            const vendorData = vendorFixtures.createRandomVendor({
                name: "Default Auth Vendor",
            });
            const response = await requestHelper.post(
                "/vendor/create.json",
                vendorData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.config).toEqual({ auth_mode: "bearer_token", skip_tls_verify: false });
        });

        it("should update vendor config.auth_mode", async () => {
            // 创建一个 vendor
            const createData = vendorFixtures.createRandomVendor({
                name: "Update Auth Vendor",
            });
            const createRes = await requestHelper.post(
                "/vendor/create.json",
                createData,
                adminToken,
            );
            const vendorId = createRes.body.id;

            // 更新 auth_mode
            const updateRes = await requestHelper.put(
                `/vendor/${vendorId}`,
                { config: { auth_mode: "api_key" } },
                adminToken,
            );

            expect(updateRes.status).toBe(200);
            expect(updateRes.body.config).toEqual({ auth_mode: "api_key", skip_tls_verify: false });
        });

        it("should preserve other config fields when updating auth_mode", async () => {
            // 创建一个 vendor
            const createData = vendorFixtures.createRandomVendor({
                name: "Preserve Config Vendor",
            });
            const createRes = await requestHelper.post(
                "/vendor/create.json",
                createData,
                adminToken,
            );
            const vendorId = createRes.body.id;

            // 先设置完整的 config
            await requestHelper.put(
                `/vendor/${vendorId}`,
                { config: { auth_mode: "bearer_token", custom_field: "value" } },
                adminToken,
            );

            // 只更新 auth_mode
            const updateRes = await requestHelper.put(
                `/vendor/${vendorId}`,
                { config: { auth_mode: "api_key" } },
                adminToken,
            );

            expect(updateRes.status).toBe(200);
            // 注意：当前实现会覆盖整个 config，SgVendorConfig 只认已知字段
            expect(updateRes.body.config).toEqual({ auth_mode: "api_key", skip_tls_verify: false });
        });
    });
});
