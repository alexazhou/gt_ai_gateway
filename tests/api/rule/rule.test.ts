import { beforeEach, describe, expect, it } from "vitest";
import { setupAdminUser } from "../../globalSetup";
import dbHelper from "../../helpers/dbHelper";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import userFixtures from "../../fixtures/userFixtures";

const adminToken = userFixtures.ADMIN_TOKEN;
const ROOT_TOKEN = "root-token-123";

let seq = 0;
function unique(prefix: string): string {
    seq += 1;
    return `${prefix}-${Date.now()}-${seq}`;
}

// 创建默认指向 mock OpenAI 的供应商；urls 覆盖时指向指定 mock 端点
async function createVendor(urls?: Record<string, string>) {
    const vendor = await requestHelper.post(
        "/vendor/create.json",
        {
            ...vendorFixtures.VENDOR_FIXTURES.openai(),
            ...(urls ? { urls } : {}),
        },
        adminToken,
    );
    expect(vendor.status).toBe(200);
    return vendor.body.id;
}

// 创建模型；failover 默认开启
async function createModel(name: string, vendorId: number, routingMode = "single", failover = true) {
    const model = await requestHelper.post(
        "/model/create.json",
        {
            name,
            routing_mode: routingMode,
            routing_config: {
                upstreams: [{ vendor_id: vendorId, enabled: true }],
                failover: { enabled: failover },
            },
        },
        adminToken,
    );
    expect(model.status).toBe(200);
    return model.body;
}

async function createUser() {
    const user = await requestHelper.post(
        "/user/create.json",
        mockHelper.generateUser(),
        adminToken,
    );
    expect(user.status).toBe(200);
    return user.body;
}

function rateLimitRule(modelId: number, rpm: number) {
    return {
        type: "rate_limit",
        name: unique("rl"),
        scope: { type: "model_id", oper: "=", values: [modelId] },
        config: { rpm },
    };
}

function accessControlRule(modelId: number, userId: number) {
    return {
        type: "forbid_access",
        name: unique("ac"),
        scope: {
            type: "and",
            values: [
                { type: "model_id", oper: "=", values: [modelId] },
                { type: "user_id", oper: "=", values: [userId] },
            ],
        },
        config: {},
    };
}

describe("Rule API", () => {
    // 每次用例前清库（含 rule 表）并重建管理员，避免全局 const 规则等跨用例污染；同时经
    // /test/cache/clear 清除服务进程内的 ruleService 规则缓存。
    beforeEach(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
    });

    it("CRUD rules via API and validates invalid payloads", async () => {
        // create
        const created = await requestHelper.post(
            "/rule/create.json",
            rateLimitRule(5, 100),
            adminToken,
        );
        expect(created.status).toBe(200);
        expect(created.body.id).toBeGreaterThan(0);
        expect(created.body.type).toBe("rate_limit");
        expect(created.body.scope).toEqual({ type: "model_id", oper: "=", values: [5] });
        expect(created.body.config).toEqual({ rpm: 100 });
        expect(created.body.enabled).toBe(true);

        // list
        const list = await requestHelper.get("/rule/list.json", adminToken);
        expect(list.status).toBe(200);
        expect(list.body.total).toBe(1);
        expect(list.body.list[0].id).toBe(created.body.id);

        // get
        const detail = await requestHelper.get(`/rule/${created.body.id}`, adminToken);
        expect(detail.status).toBe(200);
        expect(detail.body.name).toBe(created.body.name);

        // update
        const updated = await requestHelper.put(
            `/rule/${created.body.id}`,
            { ...rateLimitRule(5, 50), name: "updated-rl", enabled: false },
            adminToken,
        );
        expect(updated.status).toBe(200);
        expect(updated.body.config.rpm).toBe(50);
        expect(updated.body.enabled).toBe(false);

        // delete
        const deleted = await requestHelper.del(`/rule/${created.body.id}`, adminToken);
        expect(deleted.status).toBe(200);
        expect(deleted.body.success).toBe(true);

        const afterDelete = await requestHelper.get(`/rule/${created.body.id}`, adminToken);
        expect(afterDelete.status).toBe(404);

        // 非法载荷被拒绝
        const badScope = await requestHelper.post(
            "/rule/create.json",
            { type: "rate_limit", name: "bad", scope: { type: "and", values: [] }, config: { rpm: 1 } },
            adminToken,
        );
        expect(badScope.status).toBe(400);

        const badRpm = await requestHelper.post(
            "/rule/create.json",
            { type: "rate_limit", name: "bad", scope: { type: "const", values: [true] }, config: { rpm: -1 } },
            adminToken,
        );
        expect(badRpm.status).toBe(400);

        const badType = await requestHelper.post(
            "/rule/create.json",
            { type: "concurrency", name: "bad", scope: { type: "const", values: [true] }, config: {} },
            adminToken,
        );
        expect(badType.status).toBe(400);

        const badAccessControl = await requestHelper.post(
            "/rule/create.json",
            { type: "forbid_access", name: "bad", scope: { type: "const", values: [true] }, config: { extra: 1 } },
            adminToken,
        );
        expect(badAccessControl.status).toBe(400);

        // 非管理员被拒绝
        const nonAdmin = await createUser();
        const forbidden = await requestHelper.post(
            "/rule/create.json",
            rateLimitRule(5, 100),
            nonAdmin.token,
        );
        expect(forbidden.status).toBe(403);
    });

    it("rate limit returns 429 with Retry-After and records failed_code=rate_limit_exceeded", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("rl-model"), vendorId);
        const user = await createUser();

        // rpm=2：前 2 个请求放行，第 3 个 429
        await requestHelper.post("/rule/create.json", rateLimitRule(model.id, 2), adminToken);

        const first = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(first.status).toBe(200);

        const second = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(second.status).toBe(200);

        const limited = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBe("60");
        expect(limited.body.error.type).toBe("rate_limit_error");
        expect(limited.body.error.code).toBe("rate_limit_error");

        // 失败记录落库
        const records = await requestHelper.getFinalizedRecords(adminToken, 5);
        const failed = records.filter((r: any) => r.status === "failed");
        expect(failed.length).toBe(1);
        expect(failed[0].failed_code).toBe("rate_limit_exceeded");
    });

    it("access control returns 403 without consuming rate limit quota", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("ac-model"), vendorId);
        const user = await createUser();
        const otherUser = await createUser();

        // 同一模型上加：forbid_access 拒绝 user、rate_limit rpm=1
        await requestHelper.post(
            "/rule/create.json",
            accessControlRule(model.id, user.id),
            adminToken,
        );
        await requestHelper.post("/rule/create.json", rateLimitRule(model.id, 1), adminToken);

        // user 被 403 拒绝，不消耗限流计数
        const denied = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(denied.status).toBe(403);
        expect(denied.body.error.type).toBe("access_denied");

        // otherUser 仍保有完整配额（rpm=1 → 第一个请求放行）
        const allowed = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            otherUser.token,
        );
        expect(allowed.status).toBe(200);

        // otherUser 第二个请求 → 429（说明 user 的 403 没消耗配额）
        const limited = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            otherUser.token,
        );
        expect(limited.status).toBe(429);

        const records = await requestHelper.getFinalizedRecords(adminToken, 10);
        const deniedRecord = records.find((r: any) => r.failed_code === "access_denied");
        expect(deniedRecord).toBeDefined();
    });

    it("produces correct 403/429 error bodies across three protocols", async () => {
        // Anthropic
        const anthropicVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.anthropic(),
            adminToken,
        );
        const anthropicModel = await createModel(unique("ac-anthropic"), anthropicVendor.body.id);
        const acUser = await createUser();
        await requestHelper.post("/rule/create.json", accessControlRule(anthropicModel.id, acUser.id), adminToken);

        const anthropicDenied = await requestHelper.post(
            "/llm/v1/messages",
            mockHelper.generateAnthropicMessageRequest({ model: anthropicModel.name }),
            acUser.token,
        );
        expect(anthropicDenied.status).toBe(403);
        expect(anthropicDenied.body.type).toBe("error");
        expect(anthropicDenied.body.error.type).toBe("access_denied");

        // Responses
        const responsesVendor = await createVendor();
        const responsesModel = await createModel(unique("ac-responses"), responsesVendor);
        await requestHelper.post("/rule/create.json", accessControlRule(responsesModel.id, acUser.id), adminToken);
        const responsesDenied = await requestHelper.post(
            "/llm/v1/responses",
            mockHelper.generateResponsesRequest({ model: responsesModel.name }),
            acUser.token,
        );
        expect(responsesDenied.status).toBe(403);
        expect(responsesDenied.body.error.type).toBe("access_denied");
        expect(responsesDenied.body.error.code).toBe("access_denied");

        // Anthropic 429
        const anthropicRlVendor = await requestHelper.post(
            "/vendor/create.json",
            vendorFixtures.VENDOR_FIXTURES.anthropic(),
            adminToken,
        );
        const anthropicRlModel = await createModel(unique("rl-anthropic"), anthropicRlVendor.body.id);
        const rlUser = await createUser();
        await requestHelper.post("/rule/create.json", rateLimitRule(anthropicRlModel.id, 1), adminToken);
        const first = await requestHelper.post(
            "/llm/v1/messages",
            mockHelper.generateAnthropicMessageRequest({ model: anthropicRlModel.name }),
            rlUser.token,
        );
        expect(first.status).toBe(200);
        const anthropicLimited = await requestHelper.post(
            "/llm/v1/messages",
            mockHelper.generateAnthropicMessageRequest({ model: anthropicRlModel.name }),
            rlUser.token,
        );
        expect(anthropicLimited.status).toBe(429);
        expect(anthropicLimited.body.type).toBe("error");
        expect(anthropicLimited.body.error.type).toBe("rate_limit_error");
        expect(anthropicLimited.headers.get("retry-after")).toBe("60");
    });

    it("fails over to the next upstream when vendor-level rate limit hits", async () => {
        const vendorA = await createVendor();
        const vendorB = await createVendor();
        const modelName = unique("rl-failover");

        // first_available 自动上游：两个供应商都需同名 vendor model
        await requestHelper.post(`/vendor/${vendorA}/model/add.json`, { model_id: modelName }, adminToken);
        await requestHelper.post(`/vendor/${vendorB}/model/add.json`, { model_id: modelName }, adminToken);
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: modelName,
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        { vendor_id: vendorA, enabled: true },
                        { vendor_id: vendorB, enabled: true },
                    ],
                },
            },
            adminToken,
        );
        expect(model.status).toBe(200);

        const user = await createUser();
        // 供应商 A 级限流 rpm=1
        await requestHelper.post(
            "/rule/create.json",
            {
                type: "rate_limit",
                name: unique("rl-vendor"),
                scope: { type: "vendor_id", oper: "=", values: [vendorA] },
                config: { rpm: 1 },
            },
            adminToken,
        );

        // 第一次请求：first_available 选 A，配额未超 → 走 A 成功
        const first = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: modelName, stream: false }),
            user.token,
        );
        expect(first.status).toBe(200);

        // 第二次请求：选 A 撞限流（视为该上游繁忙）→ failover 到 B 成功
        const second = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: modelName, stream: false }),
            user.token,
        );
        expect(second.status).toBe(200);

        const records = await requestHelper.getFinalizedRecords(adminToken, 5);
        // latest 按 id 倒序：第一条是第二次请求的 record，应命中 B（供应商级限流不阻塞其它可用供应商）
        expect(records[0].status).toBe("success");
        expect(records[0].vendor_id).toBe(vendorB);
    });

    it("returns 429 when vendor-level rate limit exhausts all upstreams", async () => {
        const vendorA = await createVendor();
        const model = await createModel(unique("rl-exhaust"), vendorA);

        const user = await createUser();
        await requestHelper.post(
            "/rule/create.json",
            {
                type: "rate_limit",
                name: unique("rl-vendor-exhaust"),
                scope: { type: "vendor_id", oper: "=", values: [vendorA] },
                config: { rpm: 1 },
            },
            adminToken,
        );

        const first = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(first.status).toBe(200);

        // 唯一供应商撞限流且无其它可切换 → 429
        const second = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(second.status).toBe(429);
        expect(second.headers.get("retry-after")).toBe("60");
        expect(second.body.error.type).toBe("rate_limit_error");

        const records = await requestHelper.getFinalizedRecords(adminToken, 5);
        const failed = records.filter((r: any) => r.status === "failed");
        expect(failed.some((r: any) => r.failed_code === "rate_limit_exceeded")).toBe(true);
    });

    it("route-test (inspect mode) skips rule checks", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("inspect-model"), vendorId);
        const user = await createUser();

        // 模型级限流 rpm=1
        await requestHelper.post("/rule/create.json", rateLimitRule(model.id, 1), adminToken);

        // 真实请求消耗配额
        const first = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(first.status).toBe(200);

        // 配额已耗尽，route-test（inspect）仍正常走通（纯诊断不受限流影响）
        const routeTest = await requestHelper.post(
            "/model/route-test.json",
            { model: model.name, format: "openai" },
            adminToken,
        );
        expect(routeTest.status).toBe(200);
        expect(routeTest.body.success).toBe(true);

        // 真实请求已 429
        const limited = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            user.token,
        );
        expect(limited.status).toBe(429);
    });

    it("root bypasses all rules", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("root-model"), vendorId);

        // 全量拒绝：forbid_access const→true（拒绝所有人）+ rate_limit rpm=0（不可用）
        await requestHelper.post(
            "/rule/create.json",
            { type: "forbid_access", name: unique("root-ac"), scope: { type: "const", values: [true] }, config: {} },
            adminToken,
        );
        await requestHelper.post(
            "/rule/create.json",
            { type: "rate_limit", name: unique("root-rl"), scope: { type: "const", values: [true] }, config: { rpm: 0 } },
            adminToken,
        );

        // root 请求全程旁路
        const rootResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
            ROOT_TOKEN,
        );
        expect(rootResponse.status).toBe(200);
    });

    it("zero regression: no rules configured, behavior unchanged", async () => {
        const vendorId = await createVendor();
        const model = await createModel(unique("zero-regression"), vendorId);
        const user = await createUser();

        // 未配置任何规则时请求正常
        for (let i = 0; i < 3; i++) {
            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                mockHelper.generateOpenAIChatRequest({ model: model.name, stream: false }),
                user.token,
            );
            expect(response.status).toBe(200);
        }
    });
});
