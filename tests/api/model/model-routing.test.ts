import { beforeAll, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import userFixtures from "../../fixtures/userFixtures";

const adminToken = userFixtures.ADMIN_TOKEN;
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
            load_balance_strategy: "user",
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

        // 一次用户请求 = 一条 record，最终保留命中上游
        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(1);
        expect(records.body.list[0].status).toBe("success");
        expect(records.body.list[0].vendor_id).toBe(availableVendor.body.id);
        expect(records.body.list[0].vendor_model_name).toBe("available-model");

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
        // 每次请求一条 record：第一次请求失败切换后命中 available，第二次请求 available 未冷却直接命中
        expect(records.body.total).toBe(2);
        expect(records.body.list.filter((record: any) => (
            record.vendor_id === unavailableVendor.body.id
        ))).toHaveLength(0);
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
        expect(records.body.total).toBe(1);
        expect(records.body.list[0].vendor_id).toBe(fallbackVendor.body.id);
        expect(records.body.list[0].status).toBe("success");

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

        // 每次请求各一条 record：第一次是上游失败，第二次是无可用上游（都要记录）
        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(2);
        expect(records.body.list.every((record: any) => record.status === "failed")).toBe(true);
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
        expect(records.body.total).toBe(1);
        expect(records.body.list[0].vendor_id).toBe(backupVendor.body.id);
        expect(records.body.list[0].status).toBe("success");
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
        // 一次请求一条 record，vendor 保留最后一次尝试
        expect(records.body.total).toBe(1);
        expect(records.body.list[0].status).toBe("failed");
        expect(records.body.list[0].vendor_id).toBe(failingVendorB.body.id);
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
        expect(records.body.total).toBe(1);
        expect(records.body.list[0].status).toBe("failed");
    });

    it("records the request processing timeline as activities", async () => {
        const failVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Activity fail upstream",
                urls: { openai: "http://localhost:9999/chat/completions/error" },
            },
            adminToken,
        );
        const okVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Activity ok upstream",
                urls: { openai: "http://localhost:9999/chat/completions" },
            },
            adminToken,
        );
        const failModel = await requestHelper.post(
            `/vendor/${failVendor.body.id}/model/add.json`,
            { model_id: "activity-fail-model" },
            adminToken,
        );
        const okModel = await requestHelper.post(
            `/vendor/${okVendor.body.id}/model/add.json`,
            { model_id: "activity-ok-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "activity-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: failVendor.body.id,
                            vendor_model_id: failModel.body.id,
                            enabled: true,
                        },
                        {
                            vendor_id: okVendor.body.id,
                            vendor_model_id: okModel.body.id,
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
            mockHelper.generateOpenAIChatRequest({ model: "activity-model", stream: false }),
            user.body.token,
        );
        expect(response.status).toBe(200);

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        expect(records.body.total).toBe(1);
        const recordId = records.body.list[0].id;

        const activity = await requestHelper.get(
            `/record/${recordId}/activity.json`,
            adminToken,
        );
        expect(activity.status).toBe(200);
        expect(activity.body.record_id).toBe(recordId);

        const stages = activity.body.activities.map((a: any) => a.stage);
        // 每次尝试 = 路由 → 发起请求 → 结果；切换由序列自然体现（A失败结果 → 路由B），不单独记 failover
        expect(stages).toEqual([
            "routing",
            "upstream_attempt",
            "result",
            "routing",
            "upstream_attempt",
            "result",
        ]);

        // 第一条路由：策略 + 客户端（请求模型/协议）→ 上游（供应商/上游模型/协议）；A 失败结果带 400 与上游返回体；最终结果成功
        expect(activity.body.activities[0].details.strategy).toBe("first_available");
        expect(activity.body.activities[0].details.client.model).toBe("activity-model");
        expect(activity.body.activities[0].details.client.format).toBe("openai");
        expect(activity.body.activities[0].details.upstream.vendor).toBe("Activity fail upstream");
        expect(activity.body.activities[0].details.upstream.vendor_model).toBe("activity-fail-model");
        expect(activity.body.activities[0].details.upstream.format).toBe("openai");
        // 发起上游请求只含上游协议，不含客户端协议
        expect(activity.body.activities[1].details.upstream_format).toBe("openai");
        expect(activity.body.activities[1].details.vendor_name).toBe("Activity fail upstream");
        expect(activity.body.activities[1].details).not.toHaveProperty("client_format");
        expect(activity.body.activities[2].details.status).toBe("failed");
        expect(activity.body.activities[2].details.upstream_status).toBe(400);
        expect(activity.body.activities[2].details.response_body).toContain("Not supported model");
        expect(activity.body.activities[3].details.upstream.vendor).toBe("Activity ok upstream");
        expect(activity.body.activities[5].level).toBe("info");
        expect(activity.body.activities[5].details.status).toBe("success");
        expect(activity.body.activities[5].details.cost).toBeGreaterThanOrEqual(0);

        // 不存在的 record 返回 404
        const empty = await requestHelper.get(
            `/record/999999/activity.json`,
            adminToken,
        );
        expect(empty.status).toBe(404);
    });

    it("records a no-available-upstream activity when no upstream can be selected", async () => {
        const onlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Only failing upstream",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const onlyModel = await requestHelper.post(
            `/vendor/${onlyVendor.body.id}/model/add.json`,
            { model_id: "only-failing-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "only-failing-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: onlyVendor.body.id,
                            vendor_model_id: onlyModel.body.id,
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
        // 第一次请求让唯一上游冷却
        await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "only-failing-model", stream: false }),
            user.body.token,
        );
        // 第二次请求无可用上游
        const secondResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "only-failing-model", stream: false }),
            user.body.token,
        );
        expect(secondResponse.status).toBe(503);

        const records = await requestHelper.get(
            `/record/list.json?model_ids=${model.body.id}`,
            adminToken,
        );
        const noUpstreamRecord = records.body.list.find(
            (record: any) => record.failed_code === "no_available_upstream",
        );
        expect(noUpstreamRecord).toBeDefined();

        const activity = await requestHelper.get(
            `/record/${noUpstreamRecord.id}/activity.json`,
            adminToken,
        );
        const routingStages = activity.body.activities.filter((a: any) => a.stage === "routing");
        expect(routingStages[routingStages.length - 1].level).toBe("error");
        expect(routingStages[routingStages.length - 1].message).toBe("无可用上游");
    });

    it("does not cool down the upstream after a 4xx client error", async () => {
        const clientErrorVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Client error upstream",
                urls: { openai: "http://localhost:9999/chat/completions/error" },
            },
            adminToken,
        );
        const clientErrorModel = await requestHelper.post(
            `/vendor/${clientErrorVendor.body.id}/model/add.json`,
            { model_id: "no-cool-client-error-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "no-cool-client-error-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: clientErrorVendor.body.id,
                            vendor_model_id: clientErrorModel.body.id,
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
        // 4xx 属于请求侧错误，不标记健康状态：第二次请求仍会尝试该上游（而非"无可用上游"）
        const firstResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "no-cool-client-error-model", stream: false }),
            user.body.token,
        );
        expect(firstResponse.status).toBe(400);

        const secondResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "no-cool-client-error-model", stream: false }),
            user.body.token,
        );
        expect(secondResponse.status).toBe(400);
        expect(secondResponse.body.error.message).not.toContain("No available upstream");
    });

    it("cools down the upstream after a 402 balance error", async () => {
        const balanceVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Balance insufficient upstream",
                urls: { openai: "http://localhost:9999/chat/completions/balance" },
            },
            adminToken,
        );
        const balanceModel = await requestHelper.post(
            `/vendor/${balanceVendor.body.id}/model/add.json`,
            { model_id: "cool-balance-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "cool-balance-model",
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: balanceVendor.body.id,
                            vendor_model_id: balanceModel.body.id,
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
        // 402 余额不足视为上游故障：第一次请求后冷却，第二次请求直接无可用上游
        const firstResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "cool-balance-model", stream: false }),
            user.body.token,
        );
        expect(firstResponse.status).toBe(402);

        const secondResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "cool-balance-model", stream: false }),
            user.body.token,
        );
        expect(secondResponse.status).toBe(503);
        expect(secondResponse.body.error.message).toContain("No available upstream");
    });

    it("ignores health status and always returns the fixed upstream in single mode", async () => {
        const singleVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                ...vendorFixtures.VENDOR_FIXTURES.openai(),
                name: "Single mode cooling upstream",
                urls: { openai: "http://localhost:9999/chat/completions/unavailable" },
            },
            adminToken,
        );
        const singleModel = await requestHelper.post(
            `/vendor/${singleVendor.body.id}/model/add.json`,
            { model_id: "single-ignore-health-model" },
            adminToken,
        );
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: "single-ignore-health-model",
                routing_mode: "single",
                routing_config: {
                    upstreams: [
                        {
                            vendor_id: singleVendor.body.id,
                            vendor_model_id: singleModel.body.id,
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
        // 第一次请求失败会标记上游冷却（503 视为上游故障）
        const firstResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "single-ignore-health-model", stream: false }),
            user.body.token,
        );
        expect(firstResponse.status).toBe(503);
        expect(firstResponse.body.error.message).toBe("Mock upstream unavailable");

        // SINGLE 模式忽略健康状态：第二次请求仍会尝试固定上游，而不是"无可用上游"
        const secondResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: "single-ignore-health-model", stream: false }),
            user.body.token,
        );
        expect(secondResponse.status).toBe(503);
        expect(secondResponse.body.error.message).toBe("Mock upstream unavailable");
        expect(secondResponse.body.error.message).not.toContain("No available upstream");
    });
});
