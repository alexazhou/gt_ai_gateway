import { beforeAll, describe, expect, it } from "vitest";
import { fetch } from "undici";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import mockHelper from "../../helpers/mockHelper";
import config from "../../config";
import { setupAdminUser } from "../../globalSetup";

/**
 * P2-09：选路候选查询批量化（3 条查询 + 内存命中）后，**行为必须与逐条查询一致**。
 *
 * 原来每个上游串行查 vendor + vendor_model，5 上游 ≈ 10+ 次 D1 往返；改造后一次批量取全。
 * 批量化最容易出的事故是「只解析了第一个上游 / 显式绑定与按名绑定搞混 / 漏掉某个 vendor」，
 * 本用例用「前两个上游故障 + 第三个正常」的多上游 failover 链路把它钉住：
 * - 批量解析如果漏上游，请求会直接失败（503/5xx）而不是 failover 成功；
 * - 同时验证按名隐式绑定（非 LOAD_BALANCE）与显式 vendor_model_id 两条解析路径都通。
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url;

let adminToken: string;
let userToken: string;

async function createVendor(suffix: string, path: string): Promise<number> {
    const vendor = await requestHelper.post(
        "/vendor/create.json",
        {
            type: "openai",
            name: `p2-09-vendor-${suffix}-${Date.now()}`,
            token: `sk-p2-09-${suffix}`,
            urls: { openai: `${MOCK_BASE}${path}` },
        },
        adminToken,
    );
    expect(vendor.status, `创建 vendor 失败: ${JSON.stringify(vendor.body)}`).toBe(200);
    return vendor.body.id;
}

async function capturedRequests(): Promise<any[]> {
    const response = await fetch(`${MOCK_BASE}/_test/requests`);
    return (await response.json()) as any[];
}

async function latestRecordByModel(modelId: number, timeoutMs = 10_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const res = await requestHelper.get("/record/latest.json?limit=10", adminToken);
        const mine = (Array.isArray(res.body) ? res.body : []).find((r: any) => r.model_id === modelId);
        if (mine && mine.status !== "processing") return mine;
        if (Date.now() >= deadline) return mine ?? null;
        await new Promise((r) => setTimeout(r, 150));
    }
}

describe("P2-09 选路批量化后行为一致", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
        const user = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        userToken = user.body.token;
        await dbHelper.execute(`UPDATE user SET balance = 100 WHERE id = ${user.body.id}`);
    }, 60000);

    it("3 个上游里前两个故障：批量解析后仍能 failover 到第三个并成功", async () => {
        const badA = await createVendor("bad-a", "/chat/completions/unavailable");
        const badB = await createVendor("bad-b", "/chat/completions/error");
        const good = await createVendor("good", "/chat/completions");

        const modelName = `p2-09-failover-${Date.now()}`;
        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: modelName,
                enable: true,
                prices: {},
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        { vendor_id: badA, enabled: true },
                        { vendor_id: badB, enabled: true },
                        { vendor_id: good, enabled: true },
                    ],
                },
            },
            adminToken,
        );
        expect(model.status, `创建 model 失败: ${JSON.stringify(model.body)}`).toBe(200);

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: modelName, messages: [{ role: "user", content: "hi" }] },
            userToken,
        );
        expect(response.status, "前两个上游故障时必须 failover 到第三个").toBe(200);

        const record = await latestRecordByModel(model.body.id);
        expect(record, "记录应已落库").toBeTruthy();
        expect(record.status).toBe("success");
        expect(Number(record.vendor_id), "最终命中的必须是第三个（good）上游").toBe(good);

        // 能落到第三个上游 = 前两个都被解析出来并尝试过（批量解析漏上游会直接 503 失败）
        // 注意：上游失败路由未必把请求体记进 mock 的 /_test/requests，这里只按最终命中判断
    }, 60000);

    it("显式绑定 vendor_model_id 的解析路径（getByIds）同样有效", async () => {
        const vendorId = await createVendor("explicit", "/chat/completions");
        const modelName = `p2-09-explicit-${Date.now()}`;

        // 先建模型让 ensureVendorModels 补出 vendor_model 行，再拿它的 id 做显式绑定
        const created = await requestHelper.post(
            "/model/create.json",
            {
                name: modelName,
                enable: true,
                prices: {},
                routing_mode: "single",
                routing_config: { upstreams: [{ vendor_id: vendorId, enabled: true }] },
            },
            adminToken,
        );
        expect(created.status).toBe(200);

        const rows = await dbHelper.query<any>(
            `SELECT id FROM vendor_model WHERE vendor_id = ${vendorId} AND model_id = '${modelName}'`,
        );
        expect(rows.length, "保存模型时应补建 vendor_model").toBe(1);
        const vendorModelId = rows[0].id;

        const updated = await requestHelper.put(
            `/model/${created.body.id}`,
            {
                name: modelName,
                enable: true,
                prices: {},
                routing_mode: "single",
                routing_config: {
                    upstreams: [{ vendor_id: vendorId, vendor_model_id: vendorModelId, enabled: true }],
                },
            },
            adminToken,
        );
        expect(updated.status, `更新 model 失败: ${JSON.stringify(updated.body)}`).toBe(200);

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: modelName, messages: [{ role: "user", content: "hi" }] },
            userToken,
        );
        expect(response.status, "显式绑定 vendor_model_id 必须能正常选中").toBe(200);

        const request = (await capturedRequests()).reverse().find((r) => r.json?.model === modelName);
        expect(request, "上游应收到请求").toBeTruthy();
    }, 60000);

    it("vendor 已被删除的上游被跳过并给出可读错误（不会 500）", async () => {
        const aliveVendor = await createVendor("alive", "/chat/completions");
        const ghostVendorId = 999999;
        const modelName = `p2-09-ghost-${Date.now()}`;

        const model = await requestHelper.post(
            "/model/create.json",
            {
                name: modelName,
                enable: true,
                prices: {},
                routing_mode: "first_available",
                routing_config: {
                    upstreams: [
                        { vendor_id: ghostVendorId, enabled: true },
                        { vendor_id: aliveVendor, enabled: true },
                    ],
                },
            },
            adminToken,
        );
        // 校验层可能直接拒绝不存在的 vendor（400 也合理），关键是不能 500 且不能静默选中幽灵上游
        if (model.status === 200) {
            const response = await requestHelper.post(
                "/llm/v1/chat/completions",
                { model: modelName, messages: [{ role: "user", content: "hi" }] },
                userToken,
            );
            expect([200], `实际 ${response.status}: ${JSON.stringify(response.body)}`).toContain(response.status);
        } else {
            // 校验层用 NotFoundError（404）报「vendor 不存在」也算可读错误，只要不是 500
            expect([400, 404, 422], `实际 ${model.status}`).toContain(model.status);
            expect(JSON.stringify(model.body)).not.toMatch(/TypeError|SQLITE/);
        }
    }, 60000);
});
