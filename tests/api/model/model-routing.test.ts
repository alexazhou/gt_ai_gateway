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
        expect(response.body).not.toHaveProperty("vendor_id");
        expect(response.body).not.toHaveProperty("vendor_model_id");
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

    it("normalizes omitted upstream enabled state and rejects invalid full configurations", async () => {
        const primaryVendorModel = await requestHelper.post(
            `/vendor/${primaryVendorId}/model/add.json`,
            { model_id: "primary-explicit-upstream" },
            adminToken,
        );
        const secondaryVendorModel = await requestHelper.post(
            `/vendor/${secondaryVendorId}/model/add.json`,
            { model_id: "secondary-explicit-upstream" },
            adminToken,
        );

        const defaultEnabledResponse = await requestHelper.post(
            "/model/create.json",
            {
                name: "implicit-enabled-upstream",
                routing_mode: "single",
                routing_config: {
                    upstreams: [{ vendor_id: primaryVendorId }],
                },
            },
            adminToken,
        );
        expect(defaultEnabledResponse.status).toBe(200);
        expect(defaultEnabledResponse.body.routing_config.upstreams).toEqual([
            { vendor_id: primaryVendorId, enabled: true },
        ]);

        const wrongVendorResponse = await requestHelper.post(
            "/model/create.json",
            {
                name: "wrong-vendor-model",
                routing_mode: "single",
                routing_config: {
                    upstreams: [{
                        vendor_id: primaryVendorId,
                        vendor_model_id: secondaryVendorModel.body.id,
                        enabled: true,
                    }],
                },
            },
            adminToken,
        );
        expect(wrongVendorResponse.status).toBe(400);
        expect(wrongVendorResponse.body.error).toContain("does not belong");

        const duplicateResponse = await requestHelper.post(
            "/model/create.json",
            {
                name: "duplicate-explicit-upstream",
                routing_mode: "load_balance",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: primaryVendorId,
                            vendor_model_id: primaryVendorModel.body.id,
                            enabled: true,
                        },
                        {
                            vendor_id: primaryVendorId,
                            vendor_model_id: primaryVendorModel.body.id,
                            enabled: true,
                        },
                    ],
                },
            },
            adminToken,
        );
        expect(duplicateResponse.status).toBe(400);
        expect(duplicateResponse.body.error).toContain("Duplicate enabled upstream");

        const incompleteUpdateResponse = await requestHelper.put(
            `/model/${defaultEnabledResponse.body.id}`,
            { name: "incomplete-update" },
            adminToken,
        );
        expect(incompleteUpdateResponse.status).toBe(400);
        expect(incompleteUpdateResponse.body.error).toContain("routing_mode and routing_config are required");
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

    it("skips cooling-down upstreams on later failover requests", async () => {
        const unavailableVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Cooling unavailable upstream",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const availableVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Cooling available upstream",
                urls: { openai: "http://localhost:9999/chat/completions" },
            },
            adminToken,
        );
        const unavailableModel = await requestHelper.post(
            `/vendor/${unavailableVendor.body.id}/model/add.json`,
            { model_id: "cooling-unavailable-model" },
            adminToken,
        );
        const availableModel = await requestHelper.post(
            `/vendor/${availableVendor.body.id}/model/add.json`,
            { model_id: "cooling-available-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "cooldown-failover-model",
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
        const user = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );

        const firstResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.body.name, stream: false }),
            user.body.token,
        );
        expect(firstResponse.status).toBe(200);

        const secondResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.body.name, stream: false }),
            user.body.token,
        );
        expect(secondResponse.status).toBe(200);

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(3);
        expect(records.body.list.filter((record: any) => (
            record.vendor_id === unavailableVendor.body.id
        ))).toHaveLength(1);
        expect(records.body.list.filter((record: any) => (
            record.vendor_id === availableVendor.body.id
        ))).toHaveLength(2);
    });

    it("returns a non-retryable upstream response without switching upstreams", async () => {
        const invalidRequestVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Invalid request upstream",
                urls: { openai: "http://localhost:9999/chat/completions/error" },
            },
            adminToken,
        );
        const fallbackVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Unused fallback upstream",
                urls: { openai: "http://localhost:9999/chat/completions" },
            },
            adminToken,
        );
        const invalidRequestModel = await requestHelper.post(
            `/vendor/${invalidRequestVendor.body.id}/model/add.json`,
            { model_id: "invalid-request-model" },
            adminToken,
        );
        const fallbackModel = await requestHelper.post(
            `/vendor/${fallbackVendor.body.id}/model/add.json`,
            { model_id: "unused-fallback-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "non-retryable-failover-model",
                routing_mode: "failover",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: invalidRequestVendor.body.id,
                            vendor_model_id: invalidRequestModel.body.id,
                            enabled: true,
                        },
                        {
                            vendor_id: fallbackVendor.body.id,
                            vendor_model_id: fallbackModel.body.id,
                            enabled: true,
                        },
                    ],
                },
            },
            adminToken,
        );
        const user = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.body.name, stream: false }),
            user.body.token,
        );
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("model_not_supported");

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(1);
        expect(records.body.list[0].vendor_id).toBe(invalidRequestVendor.body.id);

        const vendorModels = await requestHelper.get(
            `/vendor/${invalidRequestVendor.body.id}/model/list.json`,
            adminToken,
        );
        expect(vendorModels.body[0].health).toEqual({});
    });
});
