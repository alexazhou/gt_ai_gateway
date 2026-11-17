/**
 * #299 把 #297 验收探针 V1/V2/V3 转成正式回归用例（四格矩阵）
 *
 * ## 为什么要这组用例
 * #297 的用例证明了「**该有留痕的时候有**」（老凭据放行 ⇒ `request_activity` 写 warn），
 * 但没证「**不该有的时候没有**」。若 warn 被写成恒追加（always-on），#297 的用例会**全绿**
 * —— 恒真判据假绿。本文件把一个维度的「有/无」扩成四格矩阵，核心是 C3 这条负向对照。
 *
 * ## 判据先行
 * 四格矩阵与逐格理由写在 `shared/gw-pc-009-warn-negative/matrix-first.md`（**写于读实现/写用例之前**）。
 * 其中 C2（老凭据 + 来源不一致）被证明为**退化格**：老凭据 payload 没有来源信息，
 * 「一致/不一致」在其上不可区分，故用「两个 vendor 各跑一遍、`expected_source` 跟实际命中走」作等价物。
 *
 * ## 变异口径（#299 交付标准 4.2）
 * 把 `senderService` 里的 warn 追加改成**无条件追加** ⇒ **C3 必须红、C1 仍绿**。
 * 「C1 仍绿」不是放宽判据，而是证明该变异**只打 C3**（C3 是唯一能抓住恒写的用例）。
 *
 * ## 两个已知坑（34 在 #297 验收时踩过，这里都避开）
 * - 判 payload 字段必须 `JSON.parse(Buffer.from(token.split(".")[1], "base64url"))`，
 *   **不要** `expect(token).toContain("source")`——token 是 base64，恒真/恒假都容易踩。
 * - 封包 `src` 口径：Anthropic 上游签出的凭据用 `"anthropic"`（客户端 Responses 方向同理），写反会假 400。
 */
import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import protocolConverterUtil from "../../../src/util/protocolConverter/protocolConverterUtil";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

let testUserToken: string;
let adminToken: string;
/** 两个 vendor（同模型名的两种「来源」） */
let vendorAId: number;
let vendorBId: number;
/** 两个网关模型名（别名：网关名 ≠ vendor model_id） */
let modelAName: string;
let modelBName: string;
let modelAId: number;
let modelBId: number;

const expectedSourceA = () => `vendor:${vendorAId}`;
const expectedSourceB = () => `vendor:${vendorBId}`;

async function latestRecordOf(modelId: number): Promise<any> {
    const records = await requestHelper.get("/record/latest.json?limit=10", adminToken);
    const hit = (records.body as any[]).find((r) => r.model_id === modelId);
    expect(hit, `必须能找到 model_id=${modelId} 的请求记录`).toBeTruthy();
    return hit;
}

async function activitiesOf(recordId: number): Promise<any[]> {
    const activity = await requestHelper.get(`/record/${recordId}/activity.json`, adminToken);
    expect(activity.status, "activity 接口必须可用（否则「无留痕」无法证伪）").toBe(200);
    return activity.body.activities as any[];
}

/** 解凭据 payload（base64url 解明文，别对整串做 contains 判断） */
function payloadOf(token: string): any {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

const uncheckedOf = (activities: any[]) =>
    activities.filter((a) => a.details?.credential_source_checked === false);

const THINKING = "x299 think";

function reasoningWith(token: string) {
    return {
        type: "reasoning",
        summary: [{ type: "summary_text", text: THINKING }],
        encrypted_content: token,
    };
}

/** 老凭据：payload 不带 source（模拟 2026-11-17 之前签发的凭据） */
function legacyToken(gatewayModelName: string) {
    return protocolConverterUtil.sealThinkingSignature("anthropic", "sig-legacy-299", {
        model: gatewayModelName,
        thinking: THINKING,
    });
}

/** 新凭据：payload 带 source */
function freshToken(gatewayModelName: string, source: string) {
    return protocolConverterUtil.sealThinkingSignature("anthropic", "sig-fresh-299", {
        model: gatewayModelName,
        source,
        thinking: THINKING,
    });
}

async function replay(gatewayModelName: string, token: string) {
    return requestHelper.post(
        "/llm/v1/responses",
        {
            model: gatewayModelName,
            input: [
                { role: "user", content: [{ type: "input_text", text: `x299-${Date.now()}` }] },
                reasoningWith(token),
            ],
            stream: false,
        },
        testUserToken,
    );
}

async function createVendor(name: string, token: string): Promise<{ vendorId: number; vendorModelId: number }> {
    const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;
    const vendor = await requestHelper.post(
        "/vendor/create.json",
        {
            type: "other",
            name,
            token,
            urls: { anthropic: `${mockBaseUrl}/messages` },
        },
        adminToken,
    );
    const vendorModel = await requestHelper.post(
        `/vendor/${vendor.body.id}/model/add.json`,
        { model_id: `${name.replace(/\s+/g, "-")}-upstream-${Date.now()}` },
        adminToken,
    );
    await requestHelper.put(
        `/vendor/${vendor.body.id}/model/${vendorModel.body.id}.json`,
        { allowed_formats: ["anthropic"] },
        adminToken,
    );
    return { vendorId: vendor.body.id, vendorModelId: vendorModel.body.id };
}

async function createGatewayModel(name: string, vendorId: number, vendorModelId: number): Promise<number> {
    const created = await requestHelper.post(
        "/model/create.json",
        {
            ...modelFixtures.createRandomModel(vendorId, name),
            routing_config: {
                upstreams: [{ vendor_id: vendorId, vendor_model_id: vendorModelId, enabled: true }],
            },
        },
        adminToken,
    );
    return created.body.id;
}

describe("#299 四格矩阵：留痕该有时有、不该有时没有（老/新凭据 × 来源对/错）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
        const userResponse = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        testUserToken = userResponse.body.token;

        const a = await createVendor("Mock Anthropic Warn A", "anthropic-warn-a-token");
        vendorAId = a.vendorId;
        const b = await createVendor("Mock Anthropic Warn B", "anthropic-warn-b-token");
        vendorBId = b.vendorId;

        modelAName = `warn-alias-a-${Date.now()}`;
        modelBName = `warn-alias-b-${Date.now()}`;
        modelAId = await createGatewayModel(modelAName, vendorAId, a.vendorModelId);
        modelBId = await createGatewayModel(modelBName, vendorBId, b.vendorModelId);
    });

    // ── C1：老凭据 + 命中 vendor A ⇒ 200 + 有 warn ──────────────────────────
    it("C1 老凭据（无 source）放行，且 activity 里有 credential_source_checked=false 的 warn", async () => {
        const token = legacyToken(modelAName);
        expect("source" in payloadOf(token), "老凭据不应带 source 字段").toBe(false);

        const response = await replay(modelAName, token);
        expect(response.status, "老凭据必须放行（升级不打断在途多轮）").toBe(200);

        const record = await latestRecordOf(modelAId);
        expect(record.vendor_id, "本请求应命中 vendor A").toBe(vendorAId);
        const unchecked = uncheckedOf(await activitiesOf(record.id));
        expect(unchecked.length, "放行 ≠ 校验过：必须留痕").toBeGreaterThan(0);
        expect(unchecked[0].level).toBe("warn");
        expect(unchecked[0].details.reason).toBe("legacy_token_without_source");
        expect(unchecked[0].details.expected_source, "留痕要写清期望来源，否则排障无法定位").toBe(expectedSourceA());
    }, 30000);

    // ── C2 等价物：老凭据 + 命中另一来源 ⇒ 同样 200 + 有 warn ───────────────
    it("C2 同一份「无来源」老凭据在另一个 vendor 上同样放行，且 expected_source 跟本次命中的 vendor 走", async () => {
        const token = legacyToken(modelBName);
        expect("source" in payloadOf(token)).toBe(false);

        const response = await replay(modelBName, token);
        expect(response.status).toBe(200);

        const record = await latestRecordOf(modelBId);
        expect(record.vendor_id).toBe(vendorBId);
        const unchecked = uncheckedOf(await activitiesOf(record.id));
        expect(unchecked.length).toBeGreaterThan(0);
        // 关键：expected_source 是本**请求**命中的 vendor，不是任何「历史来源」
        expect(unchecked[0].details.expected_source).toBe(expectedSourceB());
        expect(unchecked[0].details.expected_source).not.toBe(expectedSourceA());
    }, 30000);

    // ── C3：新凭据 + 正确来源 ⇒ 200 + **无** warn（核心反判据） ─────────────
    it("C3 新凭据 + 正确来源 ⇒ 200 且 activity 里没有任何「未校验」留痕（反判据）", async () => {
        const token = freshToken(modelAName, expectedSourceA());
        expect(payloadOf(token).source, "新凭据必须带 source").toBe(expectedSourceA());

        const response = await replay(modelAName, token);
        expect(response.status).toBe(200);
        // §4.7 顺带核一眼：客户端看到的是自己的模型名
        expect((response.body as any).model).toBe(modelAName);

        const record = await latestRecordOf(modelAId);
        const activities = await activitiesOf(record.id);
        // sanity：activity 非空，否则「空数组里没有 unchecked」是恒真
        expect(activities.length, "activity 不能是空数组，否则「无留痕」无法证伪").toBeGreaterThan(0);
        expect(uncheckedOf(activities), "来源校验过的请求不该出现「未校验」留痕").toEqual([]);
        // sanity：本次请求确实走到了协议转换（证明不是「早退所以没写 warn」）
        expect(
            activities.some((a) => a.details?.converter),
            "activity 里应有协议转换条目（否则「无 warn」可能只是没走到那一步）",
        ).toBe(true);
    }, 30000);

    // ── C4：新凭据 + 伪造来源 ⇒ 400 + 明确码 ────────────────────────────────
    it("C4 新凭据 + 伪造来源 vendor:999999 ⇒ 400 + invalid_request_error + failed_code=conversion_error", async () => {
        const token = freshToken(modelAName, "vendor:999999");
        const response = await replay(modelAName, token);

        expect(response.status, "来源不符必须明确拒绝").toBe(400);
        expect(JSON.stringify(response.body)).toContain("invalid_request_error");

        const record = await latestRecordOf(modelAId);
        expect(record.status).toBe("failed");
        expect(record.failed_code, "拒绝必须带明确码，不许 unknown_error").toBe("conversion_error");
    }, 30000);

    // ── C4'：新凭据 + 另一个**真实** vendor 的来源 ⇒ 400（比伪造 id 更硬） ──
    it("C4' 新凭据带 vendor B 的真实来源却在 vendor A 上回放 ⇒ 400（来源真实但不对必须拒）", async () => {
        expect(vendorAId).not.toBe(vendorBId);
        const token = freshToken(modelAName, expectedSourceB());
        expect(payloadOf(token).source).toBe(expectedSourceB());

        const response = await replay(modelAName, token);
        expect(response.status, "同模型名、来源是真实 vendor 但不对，也必须拒绝").toBe(400);
        expect(JSON.stringify(response.body)).toContain("invalid_request_error");

        const record = await latestRecordOf(modelAId);
        expect(record.failed_code).toBe("conversion_error");
    }, 30000);
});
