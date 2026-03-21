import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper"
import { setupAdminUser } from "../../globalSetup";

/**
 * Model Endpoint Positive Tests
 */

const adminToken = "admin-token-123";
let openaiVendorId: number;
let anthropicVendorId: number;
let createdModelId: number;

describe("Model API (Positive)", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();

        // Create vendors for model tests (admin user already created)
        const openaiVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        openaiVendorId = openaiVendor.body.id;

        const anthropicVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.anthropic(),
            adminToken,
        );
        anthropicVendorId = anthropicVendor.body.id;
    });

    describe("POST /model/create.json", () => {
        it("should create a model linked to OpenAI vendor", async () => {
            const modelData = modelFixtures.createRandomModel(
                openaiVendorId,
                "gpt-3.5-turbo",
            );
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty("id");
            expect(response.body.name).toBe("gpt-3.5-turbo");
            expect(response.body.vendor_id).toBe(openaiVendorId);
            expect(response.body).toHaveProperty("created_at");
            expect(response.body).toHaveProperty("updated_at");
            expect(response.body).toHaveProperty("enable");
            expect(response.body.enable).toBeTruthy();

            createdModelId = response.body.id;
        });

        it("should create a model linked to Anthropic vendor", async () => {
            const modelData = modelFixtures.createRandomModel(
                anthropicVendorId,
                "claude-3-haiku-20240307",
            );
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("claude-3-haiku-20240307");
            expect(response.body.vendor_id).toBe(anthropicVendorId);
        });

        it("should create a random model", async () => {
            const modelData = modelFixtures.createRandomModel(openaiVendorId);
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.vendor_id).toBe(openaiVendorId);
            expect(response.body.name).toBeTruthy();
        });
    });

    describe("GET /model/list.json", () => {
        it("should return a list of models", async () => {
            const response = await requestHelper.get(
                "/model/list.json",
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(Array.isArray(response.body.list)).toBe(true);
            expect(response.body.total).toBeGreaterThan(0);
        });

        it("should return models with correct structure", async () => {
            const response = await requestHelper.get(
                "/model/list.json",
                adminToken,
            );
            const model = response.body.list[0];

            expect(model).toHaveProperty("id");
            expect(model).toHaveProperty("name");
            expect(model).toHaveProperty("vendor_id");
            expect(model).toHaveProperty("created_at");
            expect(model).toHaveProperty("updated_at");
            expect(model).toHaveProperty("enable");
        });

        it("should include models from different vendors", async () => {
            const response = await requestHelper.get(
                "/model/list.json",
                adminToken,
            );

            const vendorIds = response.body.list.map((m: any) => m.vendor_id);
            expect(vendorIds).toContain(openaiVendorId);
            expect(vendorIds).toContain(anthropicVendorId);
        });
    });

    describe("Model Enable/Disable", () => {
        let disabledModelId: number;
        let enabledModelId: number;

        it("should create a disabled model", async () => {
            const modelData = modelFixtures.createRandomModel(openaiVendorId);
            modelData.enable = false;
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.enable).toBeFalsy();
            disabledModelId = response.body.id;
        });

        it("should find disabled model in list", async () => {
            const response = await requestHelper.get(
                "/model/list.json",
                adminToken,
            );
            const disabledModel = response.body.list.find((m: any) => m.id === disabledModelId);
            expect(disabledModel).toBeDefined();
            expect(disabledModel.enable).toBeFalsy();
        });

        it("should create an enabled model by default", async () => {
            const modelData = modelFixtures.createRandomModel(openaiVendorId);
            // 不传 enable 字段
            delete modelData.enable;
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.enable).toBeTruthy();
            enabledModelId = response.body.id;
        });

        it("should create an explicitly enabled model", async () => {
            const modelData = modelFixtures.createRandomModel(openaiVendorId);
            modelData.enable = true;
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.enable).toBeTruthy();
        });
    });

    describe("PUT /model/:id", () => {
        let modelToUpdate: any;

        beforeAll(async () => {
            const modelData = modelFixtures.createRandomModel(openaiVendorId, "model-to-update");
            const response = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );
            modelToUpdate = response.body;
        });

        it("should update model name", async () => {
            const response = await requestHelper.put(
                `/model/${modelToUpdate.id}`,
                { name: "updated-gpt-3.5" },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("updated-gpt-3.5");
            expect(response.body.vendor_id).toBe(modelToUpdate.vendor_id);
        });

        it("should update model vendor_id", async () => {
            const response = await requestHelper.put(
                `/model/${modelToUpdate.id}`,
                { vendor_id: anthropicVendorId },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.vendor_id).toBe(anthropicVendorId);
        });

        it("should update model enable to false", async () => {
            const response = await requestHelper.put(
                `/model/${modelToUpdate.id}`,
                { enable: false },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.enable).toBeFalsy();
        });

        it("should update model enable to true", async () => {
            const response = await requestHelper.put(
                `/model/${modelToUpdate.id}`,
                { enable: true },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.enable).toBeTruthy();
        });

        it("should update multiple fields at once", async () => {
            const modelData = modelFixtures.createRandomModel(openaiVendorId, "multi-field-model");
            const createResponse = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );
            const modelId = createResponse.body.id;

            const response = await requestHelper.put(
                `/model/${modelId}`,
                {
                    name: "multi-field-updated",
                    vendor_id: anthropicVendorId,
                    enable: false,
                },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe("multi-field-updated");
            expect(response.body.vendor_id).toBe(anthropicVendorId);
            expect(response.body.enable).toBeFalsy();
        });

        it("should preserve fields that are not updated", async () => {
            const modelData = modelFixtures.createRandomModel(openaiVendorId, "preserve-fields-model");
            const createResponse = await requestHelper.post(
                "/model/create.json",
                modelData,
                adminToken,
            );
            const modelId = createResponse.body.id;
            const originalName = createResponse.body.name;

            const response = await requestHelper.put(
                `/model/${modelId}`,
                { vendor_id: anthropicVendorId },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe(originalName);
            expect(response.body.vendor_id).toBe(anthropicVendorId);
        });
    });

    describe("Duplicate Enabled Model Detection", () => {
        let enabledModel1: any;
        let disabledModel1: any;
        let enabledModel2: any;

        beforeAll(async () => {
            const enabled1 = await requestHelper.post(
                "/model/create.json",
                { name: "duplicate-test-1", vendor_id: openaiVendorId, enable: true },
                adminToken,
            );
            enabledModel1 = enabled1.body;

            const disabled1 = await requestHelper.post(
                "/model/create.json",
                { name: "duplicate-test-2", vendor_id: openaiVendorId, enable: false },
                adminToken,
            );
            disabledModel1 = disabled1.body;

            const enabled2 = await requestHelper.post(
                "/model/create.json",
                { name: "duplicate-test-3", vendor_id: openaiVendorId, enable: true },
                adminToken,
            );
            enabledModel2 = enabled2.body;
        });

        it("should return error when editing model to enabled with existing enabled model name", async () => {
            const response = await requestHelper.put(
                `/model/${disabledModel1.id}`,
                { name: enabledModel1.name, enable: true },
                adminToken,
            );

            expect(response.status).toBe(409);
            expect(response.body.error).toContain("already exists");
        });

        it("should succeed when editing model to disabled with existing enabled model name", async () => {
            const response = await requestHelper.put(
                `/model/${disabledModel1.id}`,
                { name: enabledModel1.name, enable: false },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe(enabledModel1.name);
            expect(response.body.enable).toBeFalsy();
        });

        it("should return error when editing model enable to true with duplicate name", async () => {
            const response = await requestHelper.put(
                `/model/${disabledModel1.id}`,
                { name: "new-duplicate-name", enable: true },
                adminToken,
            );

            expect(response.status).toBe(200);

            const duplicateResponse = await requestHelper.put(
                `/model/${enabledModel2.id}`,
                { name: "new-duplicate-name", enable: true },
                adminToken,
            );

            expect(duplicateResponse.status).toBe(409);
            expect(duplicateResponse.body.error).toContain("already exists");
        });

        it("should return error when creating enabled model with existing enabled name", async () => {
            const response = await requestHelper.post(
                "/model/create.json",
                { name: enabledModel1.name, vendor_id: openaiVendorId, enable: true },
                adminToken,
            );

            expect(response.status).toBe(409);
            expect(response.body.error).toContain("already exists");
        });

        it("should succeed when creating disabled model with existing enabled name", async () => {
            const response = await requestHelper.post(
                "/model/create.json",
                { name: enabledModel1.name, vendor_id: openaiVendorId, enable: false },
                adminToken,
            );

            expect(response.status).toBe(200);
            expect(response.body.name).toBe(enabledModel1.name);
            expect(response.body.enable).toBeFalsy();
        });
    });
});
