/**
 * #249：`request_activity` 的 result 阶段 `stop_reason_source` 端到端验证。
 *
 * 三条判据都在这里落地（活动日志是数据库真值，不是打桩）：
 * 1. 上游真给了 finish_reason ⇒ `upstream`
 * 2. 上游漏发 finish_reason 直接 [DONE]（#246 D2 的兜底路径）⇒ `synthesized`
 * 3. 非该路径（同一协议直通、没有转换器）⇒ `upstream`，不误标
 *
 * 同时把客户端拿到的响应体原样落盘（`CAPTURE_DIR`），用于「改动前后字节级不变」的比对。
 * 比对模式：`CAPTURE_ONLY=1` 时只抓响应体、跳过活动断言（跑改前基线用）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

const CAPTURE_ONLY = process.env.CAPTURE_ONLY === "1";
const CAPTURE_DIR = process.env.CAPTURE_DIR || "";
/** 基线抓取模式下只记录不判来源（改前代码没有这个键，跑基线用） */
function expectSource(details: Record<string, any>, expected: string): void {
    if (CAPTURE_ONLY) return;
    expect(details.stop_reason_source).toBe(expected);
}

let adminToken: string;
let userToken: string;
/** 客户端 anthropic → 上游 openai 且上游漏发 finish_reason（→ synthesized） */
let synthesizedModelName: string;
/** 客户端 anthropic → 上游 openai，上游正常给 finish_reason（→ upstream） */
let upstreamModelName: string;
/** 客户端 openai → 上游 openai，无转换器（→ upstream） */
let passthroughModelName: string;

const createdModelIds: number[] = [];

function writeCapture(name: string, body: string): void {
    if (!CAPTURE_DIR) return;
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CAPTURE_DIR, `${name}.txt`), body);
}

/** 取某条记录里 result 阶段活动的 details（数据库真值） */
async function getResultDetails(modelId: number, captureName: string): Promise<Record<string, any>> {
    const records = await requestHelper.get(`/record/list.json?model_ids=${modelId}`, adminToken);
    expect(records.body.total).toBe(1);
    const recordId = records.body.list[0].id;

    const activity = await requestHelper.get(`/record/${recordId}/activity.json`, adminToken);
    expect(activity.status).toBe(200);
    // 活动原文落盘：验收要的是「活动日志实际 JSON 片段」，不是转述
    writeCapture(`activity-${captureName}.json`, JSON.stringify(activity.body, null, 1));

    const result = activity.body.activities.filter((a: any) => a.stage === "result");
    expect(result.length).toBeGreaterThan(0);
    return result[result.length - 1].details;
}

async function createVendorModel(vendorName: string, upstreamPath: string, modelName: string): Promise<void> {
    const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;
    const vendor = await requestHelper.post(
        "/vendor/create.json",
        {
            ...vendorFixtures.VENDOR_FIXTURES.openai(),
            name: vendorName,
            urls: { openai: `${mockBaseUrl}${upstreamPath}` },
        },
        adminToken,
    );
    expect(vendor.status).toBe(200);

    const model = await requestHelper.post(
        "/model/create.json",
        modelFixtures.createRandomModel(vendor.body.id, modelName),
        adminToken,
    );
    expect(model.status).toBe(200);
    createdModelIds.push(model.body.id);
}

describe("#249 stop_reason_source（result 活动）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const user = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        userToken = user.body.token;

        const suffix = Date.now();
        synthesizedModelName = `no-finish-model-${suffix}`;
        upstreamModelName = `with-finish-model-${suffix}`;
        passthroughModelName = `passthrough-model-${suffix}`;

        await createVendorModel("Mock No Finish Upstream", "/chat/completions/no-finish-reason", synthesizedModelName);
        await createVendorModel("Mock With Finish Upstream", "/chat/completions", upstreamModelName);
        await createVendorModel("Mock Passthrough Upstream", "/chat/completions", passthroughModelName);
    });

    afterAll(async () => {
        await dbHelper.truncate();
    });

    it("上游漏发 finish_reason 直接 [DONE] ⇒ stop_reason_source = synthesized", async () => {
        const res = await requestHelper.post(
            "/llm/v1/messages",
            mockHelper.generateAnthropicMessageRequest({ model: synthesizedModelName, stream: true }),
            userToken,
        );
        expect(res.status).toBe(200);
        writeCapture("anthropic-client-synthesized", String(res.body));

        const details = await getResultDetails(createdModelIds[0], "synthesized");
        // 兜底值仍是 end_turn（#246 语义不变），但来源被标成 synthesized
        expectSource(details, "synthesized");
    });

    it("上游真给了 finish_reason ⇒ stop_reason_source = upstream", async () => {
        const res = await requestHelper.post(
            "/llm/v1/messages",
            mockHelper.generateAnthropicMessageRequest({ model: upstreamModelName, stream: true }),
            userToken,
        );
        expect(res.status).toBe(200);
        writeCapture("anthropic-client-upstream", String(res.body));

        const details = await getResultDetails(createdModelIds[1], "upstream");
        expectSource(details, "upstream");
    });

    it("同协议直通（无转换器）⇒ stop_reason_source = upstream，不误标 synthesized", async () => {
        const res = await requestHelper.post(
            "/llm/v1/chat/completions",
            mockHelper.generateOpenAIChatRequest({ model: passthroughModelName, stream: true }),
            userToken,
        );
        expect(res.status).toBe(200);
        writeCapture("openai-client-passthrough", String(res.body));

        const details = await getResultDetails(createdModelIds[2], "passthrough");
        expectSource(details, "upstream");
    });
});
