import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import modelFixtures from "../../fixtures/modelFixtures";
import mockHelper from "../../helpers/mockHelper";
import config from "../../config";

/**
 * P1-10 验收门：**选路是读路径，不能写库**。
 *
 * 修复前 `resolveAvailableCandidates()` 在找不到 `vendor_model` 行时会顺手 `create()` 补建——
 * 也就是一个普通的推理请求（理论上纯读）会往库里写。后果：
 * - 请求路径（含多 isolate 并发）产生额外 D1 写与非必要事务；
 * - 配置错误被「静默补齐」掩盖，运维看不到配置漂移。
 *
 * 修复后：请求链路只读，候选全不可用时直接抛
 * `No available upstream for model X: <逐条原因>`（503），记录落 `NO_AVAILABLE_UPSTREAM`；
 * `vendor_model` 的补建挪到配置写入时（`ensureVendorModels`，由 model create/update 调用）。
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url;

let adminToken: string;
let userToken: string;
let vendorId: number;

async function vendorModelCount(vendor: number, modelName: string): Promise<number> {
    const rows = await dbHelper.query<any>(
        `SELECT id FROM vendor_model WHERE vendor_id = ${vendor} AND model_id = '${modelName}'`,
    );
    return rows.length;
}

function toModelRequest(model: any) {
    return {
        name: model.name,
        enable: Boolean(model.enable),
        prices: model.prices ?? {},
        routing_mode: model.routing_mode,
        routing_config: model.routing_config,
    };
}

async function createModel(name: string): Promise<any> {
    const response = await requestHelper.post(
        "/model/create.json",
        modelFixtures.createRandomModel(vendorId, name),
        adminToken,
    );
    expect(response.status, `创建 model 失败: ${JSON.stringify(response.body)}`).toBe(200);
    return response.body;
}

describe("P1-10 选路读路径不写库", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const user = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        userToken = user.body.token;

        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "openai",
                name: "routing-read-path-vendor",
                token: "sk-routing-read-path",
                urls: { openai: `${MOCK_BASE}/chat/completions` },
            },
            adminToken,
        );
        expect(vendor.status).toBe(200);
        vendorId = vendor.body.id;
    }, 60000);

    it("创建模型（配置写入）时就补齐 vendor_model，不等到请求时补", async () => {
        const name = `routing-created-${Date.now()}`;
        await createModel(name);

        expect(await vendorModelCount(vendorId, name), "配置写入应补建 vendor_model").toBeGreaterThan(0);
    });

    it("正常推理请求不改动 vendor_model 行数（读路径零写）", async () => {
        const name = `routing-normal-${Date.now()}`;
        await createModel(name);
        const before = await vendorModelCount(vendorId, name);

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: name, messages: [{ role: "user", content: "hi" }] },
            userToken,
        );
        expect(response.status, "mock 上游应正常返回").toBe(200);

        expect(await vendorModelCount(vendorId, name)).toBe(before);
    });

    it("配置漂移（vendor_model 被删）时请求报可读错误、记 NO_AVAILABLE_UPSTREAM，且不会偷偷补建", async () => {
        const name = `routing-drift-${Date.now()}`;
        const model = await createModel(name);

        // 模拟运维/迁移导致的配置漂移
        await dbHelper.execute(`DELETE FROM vendor_model WHERE vendor_id = ${vendorId} AND model_id = '${name}'`);
        expect(await vendorModelCount(vendorId, name)).toBe(0);

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: name, messages: [{ role: "user", content: "hi" }] },
            userToken,
        );

        // 不能是 200：配置不可用时必须失败，并给出能定位的原因
        expect(response.status).toBe(503);
        expect(JSON.stringify(response.body)).toContain("No available upstream");
        expect(JSON.stringify(response.body)).toContain(name);

        // 关键：请求没有把 vendor_model 补回来（读路径不写库）
        expect(
            await vendorModelCount(vendorId, name),
            "请求链路不得补建 vendor_model（P1-10 的核心）",
        ).toBe(0);

        const records = await requestHelper.get("/record/latest.json?limit=10", adminToken);
        const mine = (Array.isArray(records.body) ? records.body : []).find((r: any) => r.model_id === model.id);
        expect(mine, "失败也要落记录").toBeTruthy();
        expect(mine.status).toBe("failed");
        expect(mine.failed_code).toBe("no_available_upstream");
    });

    it("配置写入（PUT /model/:id）时会把漂移的 vendor_model 补回来", async () => {
        const name = `routing-repair-${Date.now()}`;
        const model = await createModel(name);

        await dbHelper.execute(`DELETE FROM vendor_model WHERE vendor_id = ${vendorId} AND model_id = '${name}'`);
        expect(await vendorModelCount(vendorId, name)).toBe(0);

        const response = await requestHelper.put(
            `/model/${model.id}`,
            toModelRequest(model),
            adminToken,
        );
        expect(response.status).toBe(200);

        expect(
            await vendorModelCount(vendorId, name),
            "配置写入应负责补建（写路径做写事）",
        ).toBeGreaterThan(0);

        // 补建之后请求恢复正常
        const llmResponse = await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: name, messages: [{ role: "user", content: "hi" }] },
            userToken,
        );
        expect(llmResponse.status).toBe(200);
    });
});
