import { beforeAll, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";

const adminToken = "admin-token-123";
let primaryVendorId: number;
let secondaryVendorId: number;


describe("Model multi-upstream routing", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();

        const primary = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        primaryVendorId = primary.body.id;

        const secondary = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.openai(),
            adminToken,
        );
        secondaryVendorId = secondary.body.id;
    });

    it("accepts one enabled upstream for load balance mode", async () => {
        await requestHelper.post(
            `/vendor/${primaryVendorId}/model/add.json`,
            { model_id: "one-upstream-load-balance" },
            adminToken,
        );
        const response = await requestHelper.post(
            "/model/create.json",
            {
                name: "one-upstream-load-balance",
                routing_mode: "load_balance",
                routing_config: {
                    upstreams: [{ vendor_id: primaryVendorId, enabled: true }],
                },
            },
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.routing_mode).toBe("load_balance");
        expect(response.body.routing_config).toEqual({
            upstreams: [{ vendor_id: primaryVendorId, enabled: true }],
        });
        expect(response.body.vendor_id).toBe(primaryVendorId);
    });

    it("requires automatic upstreams to match vendor models outside single mode", async () => {
        const response = await requestHelper.post(
            "/model/create.json",
            {
                name: "missing-automatic-vendor-model",
                routing_mode: "failover",
                routing_config: {
                    upstreams: [{ vendor_id: primaryVendorId, enabled: true }],
                },
            },
            adminToken,
        );

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("does not have model");
    });

    it("rejects multiple enabled upstreams in single mode", async () => {
        const response = await requestHelper.post(
            "/model/create.json",
            {
                name: "invalid-single",
                routing_mode: "single",
                routing_config: {
                    upstreams: [
                        { vendor_id: primaryVendorId, enabled: true },
                        { vendor_id: secondaryVendorId, enabled: true },
                    ],
                },
            },
            adminToken,
        );

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("exactly one");
    });

    it("creates one request record for each failover attempt", async () => {
        const unavailableVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Unavailable upstream",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const availableVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Available upstream",
                urls: { openai: "http://localhost:9999/chat/completions" },
            },
            adminToken,
        );
        const unavailableModel = await requestHelper.post(
            `/vendor/${unavailableVendor.body.id}/model/add.json`,
            { model_id: "unavailable-model" },
            adminToken,
        );
        const availableModel = await requestHelper.post(
            `/vendor/${availableVendor.body.id}/model/add.json`,
            { model_id: "available-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "failover-model",
                routing_mode: "failover",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: unavailableVendor.body.id,
                            vendor_model_id: unavailableModel.body.id,
                            enabled: true,
                        },
                        {
                            vendor_id: availableVendor.body.id,
                            vendor_model_id: availableModel.body.id,
                            enabled: true,
                        },
                    ],
                },
            },
            adminToken,
        );
        expect(model.status).toBe(200);

        const user = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "failover-model", stream: false }),
            user.body.token,
        );

        expect(response.status).toBe(200);
        expect(response.body.model).toBe("available-model");

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(2);
        expect(records.body.list[0].status).toBe("success");
        expect(records.body.list[0].vendor_id).toBe(availableVendor.body.id);
        expect(records.body.list[0].vendor_model_name).toBe("available-model");
        expect(records.body.list[1].status).toBe("failed");
        expect(records.body.list[1].vendor_id).toBe(unavailableVendor.body.id);
        expect(records.body.list[1].vendor_model_name).toBe("unavailable-model");

        const failedVendorModels = await requestHelper.get(
            `/vendor/${unavailableVendor.body.id}/model/list.json`,
            adminToken,
        );
        expect(failedVendorModels.body[0].health.openai.last_failure_at).toBeTruthy();
    });
});
