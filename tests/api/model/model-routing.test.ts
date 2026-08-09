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
            failover: { enabled: true },
        });
        expect(response.body).not.toHaveProperty("vendor_id");
        expect(response.body).not.toHaveProperty("vendor_model_id");
    });

    it("allows load-balance automatic upstreams without creating vendor model records", async () => {
        const modelName = "automatic-load-balance-model";
        const response = await requestHelper.post(
            "/model/create.json",
            {
                name: modelName,
                routing_mode: "load_balance",
                routing_config: {
                    upstreams: [
                        { vendor_id: primaryVendorId, enabled: true },
                        { vendor_id: secondaryVendorId, enabled: true },
                    ],
                },
            },
            adminToken,
        );

        expect(response.status).toBe(200);

        const user = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        const upstreamResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: modelName, stream: false }),
            user.body.token,
        );

        expect(upstreamResponse.status).toBe(200);
        expect(upstreamResponse.body.model).toBe(modelName);

        const primaryVendorModels = await requestHelper.get(
            `/vendor/${primaryVendorId}/model/list.json`,
            adminToken,
        );
        const secondaryVendorModels = await requestHelper.get(
            `/vendor/${secondaryVendorId}/model/list.json`,
            adminToken,
        );
        expect(primaryVendorModels.body.some((item: any) => item.model_id === modelName)).toBe(false);
        expect(secondaryVendorModels.body.some((item: any) => item.model_id === modelName)).toBe(false);
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
                routing_mode: "first_available",
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
        // 健康状态不再持久化到 vendor_model 表
        expect(failedVendorModels.body[0]).not.toHaveProperty("health");
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
                routing_mode: "first_available",
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

    it("fails over to the next upstream on any non-success response", async () => {
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
                name: "Fallback upstream",
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
                routing_mode: "first_available",
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
        // 第一个上游返回 400，任何非成功响应都会切换到下一个上游
        expect(response.status).toBe(200);
        expect(response.body.model).toBe("unused-fallback-model");

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(2);
        expect(records.body.list[0].vendor_id).toBe(fallbackVendor.body.id);
        expect(records.body.list[0].status).toBe("success");
        expect(records.body.list[1].vendor_id).toBe(invalidRequestVendor.body.id);
        expect(records.body.list[1].status).toBe("failed");

        const vendorModels = await requestHelper.get(
            `/vendor/${invalidRequestVendor.body.id}/model/list.json`,
            adminToken,
        );
        expect(vendorModels.body[0]).not.toHaveProperty("health");
    });

    it("returns the failure directly when failover is disabled", async () => {
        const failingVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Failing upstream (no failover)",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const failingModel = await requestHelper.post(
            `/vendor/${failingVendor.body.id}/model/add.json`,
            { model_id: "no-failover-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "no-failover-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: failingVendor.body.id,
                            vendor_model_id: failingModel.body.id,
                            enabled: true,
                        },
                    ],
                    failover: { enabled: false },
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
            mockHelper.generateOpenAIChatRequest({ model: "no-failover-model", stream: false }),
            user.body.token,
        );

        expect(response.status).toBe(503);

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(1);
    });

    it("records upstream failure even when failover is disabled", async () => {
        const failingVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Failing upstream (mark anyway)",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const failingModel = await requestHelper.post(
            `/vendor/${failingVendor.body.id}/model/add.json`,
            { model_id: "mark-anyway-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "mark-anyway-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: failingVendor.body.id,
                            vendor_model_id: failingModel.body.id,
                            enabled: true,
                        },
                    ],
                    failover: { enabled: false },
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

        const firstResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "mark-anyway-model", stream: false }),
            user.body.token,
        );
        expect(firstResponse.status).toBe(503);

        // 第一次失败已把上游标记冷却（即使 failover 关闭），第二次请求直接无可用上游
        const secondResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "mark-anyway-model", stream: false }),
            user.body.token,
        );
        expect(secondResponse.status).toBe(503);
        expect(secondResponse.body.error.message).toContain("No available upstream");

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(1);
    });

    it("fails over automatic upstreams (no vendor_model_id) in first_available mode", async () => {
        const primaryVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Auto primary unavailable",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const backupVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Auto backup",
                urls: { openai: "http://localhost:9999/chat/completions" },
            },
            adminToken,
        );
        // first_available 要求自动上游在保存时能匹配到同名 vendor model
        await requestHelper.post(
            `/vendor/${primaryVendor.body.id}/model/add.json`,
            { model_id: "auto-first-available" },
            adminToken,
        );
        await requestHelper.post(
            `/vendor/${backupVendor.body.id}/model/add.json`,
            { model_id: "auto-first-available" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "auto-first-available",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        { vendor_id: primaryVendor.body.id, enabled: true },
                        { vendor_id: backupVendor.body.id, enabled: true },
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
            mockHelper.generateOpenAIChatRequest({ model: "auto-first-available", stream: false }),
            user.body.token,
        );

        expect(response.status).toBe(200);
        expect(response.body.model).toBe("auto-first-available");

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(2);
        expect(records.body.list[0].vendor_id).toBe(backupVendor.body.id);
        expect(records.body.list[1].vendor_id).toBe(primaryVendor.body.id);
    });

    it("returns the last upstream error when all failover attempts fail", async () => {
        const failingVendorA = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Exhaust failing upstream A",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const failingVendorB = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Exhaust failing upstream B",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const failingModelA = await requestHelper.post(
            `/vendor/${failingVendorA.body.id}/model/add.json`,
            { model_id: "exhaust-fail-a" },
            adminToken,
        );
        const failingModelB = await requestHelper.post(
            `/vendor/${failingVendorB.body.id}/model/add.json`,
            { model_id: "exhaust-fail-b" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "exhaust-failover-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: failingVendorA.body.id,
                            vendor_model_id: failingModelA.body.id,
                            enabled: true,
                        },
                        {
                            vendor_id: failingVendorB.body.id,
                            vendor_model_id: failingModelB.body.id,
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
            mockHelper.generateOpenAIChatRequest({ model: "exhaust-failover-model", stream: false }),
            user.body.token,
        );

        // 回传最后一个上游的错误响应（mock 的 503 body），而非 "No available upstream"
        expect(response.status).toBe(503);
        expect(response.body.error.message).toBe("Mock upstream unavailable");

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(2);
        expect(records.body.list.every((record: any) => record.status === "failed")).toBe(true);
    });

    it("returns 502 when all failover attempts fail with network errors", async () => {
        const deadVendorA = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Dead network upstream A",
                urls: { openai: "http://localhost:1/chat/completions" },
            },
            adminToken,
        );
        const deadVendorB = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Dead network upstream B",
                urls: { openai: "http://localhost:1/chat/completions" },
            },
            adminToken,
        );
        const deadModelA = await requestHelper.post(
            `/vendor/${deadVendorA.body.id}/model/add.json`,
            { model_id: "dead-net-a" },
            adminToken,
        );
        const deadModelB = await requestHelper.post(
            `/vendor/${deadVendorB.body.id}/model/add.json`,
            { model_id: "dead-net-b" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "dead-network-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: deadVendorA.body.id,
                            vendor_model_id: deadModelA.body.id,
                            enabled: true,
                        },
                        {
                            vendor_id: deadVendorB.body.id,
                            vendor_model_id: deadModelB.body.id,
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
            mockHelper.generateOpenAIChatRequest({ model: "dead-network-model", stream: false }),
            user.body.token,
        );

        expect(response.status).toBe(502);
        expect(response.body.error.message).toContain("All upstreams failed");

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(2);
    });
});
