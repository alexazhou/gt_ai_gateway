import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import testHelpers from "../../testHelpers";

/**
 * Gateway - Model Enable Filter Tests
 */

const adminToken = "admin-token-123";
const normalToken = "normal-token-123";
let openaiVendorId: number;
let disabledModelId: number;
let enabledModelId: number;

describe("Gateway - Model Enable Filter", () => {
    beforeAll(async () => {
        await testHelpers.truncate();

        // Insert normal user via API (admin user already created in globalSetup)
        const normalUserResponse = await requestHelper.post(
            "/user/create.json",
            {
                name: "Normal User",
                token: normalToken,
                type: "normal",
            },
            adminToken,
        );

        // Create vendor (requires admin)
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        openaiVendorId = vendor.body.id;

        // Create disabled model (requires admin)
        const disabledModel = await requestHelper.post(
            "/model/create.json",
            {
                name: "disabled-model",
                vendor_id: openaiVendorId,
                enable: false,
            },
            adminToken,
        );
        disabledModelId = disabledModel.body.id;

        // Create enabled model (requires admin)
        const enabledModel = await requestHelper.post(
            "/model/create.json",
            {
                name: "enabled-model",
                vendor_id: openaiVendorId,
                enable: true,
            },
            adminToken,
        );
        enabledModelId = enabledModel.body.id;
    });

    it("should reject request to disabled model", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: "disabled-model",
            stream: false,
        });

        const response = await requestHelper.post(
            "/v1/chat/completions",
            chatRequest,
            normalToken,
        );

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("model not found");
    });

    it("should allow request to enabled model", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: "enabled-model",
            stream: false,
        });

        const response = await requestHelper.post(
            "/v1/chat/completions",
            chatRequest,
            normalToken,
        );

        // 请求应该被转发，返回 mock 服务器的响应
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("id");
        expect(response.body).toHaveProperty("choices");
    }, 30000);

    it("should reject request to model that does not exist", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: "non-existent-model",
            stream: false,
        });

        const response = await requestHelper.post(
            "/v1/chat/completions",
            chatRequest,
            normalToken,
        );

        expect(response.status).toBe(401);
        expect(response.body.error).toBe("model not found");
    });
});