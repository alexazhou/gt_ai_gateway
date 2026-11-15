import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";
import modelFixtures from "../../fixtures/modelFixtures";

/**
 * P1-06 回归：上游 200 + 空 body / HTML / 截断 JSON
 *
 * 修复前：`detectUpstreamBodyFailure` 解析不出 JSON 就返回 null，于是这类响应被记成
 * `status=success` + `cost=0`，客户端拿到"200 + 空/HTML"——统计与计费被污染。
 * 修复后：按 `upstream_error` 记 failed + cost=0，响应体仍**原样透传**（不改上游状态码）。
 *
 * 三形态 × 三协议 = 9 条用例。上游行为由 tests/helpers/mockServer.ts 的
 * handleNonJsonUpstream 提供（URL 后缀 /empty-body、/html-body、/truncated-json）。
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url;

const EMPTY_BODY = "";
const HTML_BODY = "<html><body><h1>502 Bad Gateway</h1></body></html>";
const TRUNCATED_JSON = '{"id":"cmpl_truncated","object":"chat.completion","choices":[';

type Scenario = "empty-body" | "html-body" | "truncated-json";

const SCENARIOS: { key: Scenario; expectedBody: string }[] = [
    { key: "empty-body", expectedBody: EMPTY_BODY },
    { key: "html-body", expectedBody: HTML_BODY },
    { key: "truncated-json", expectedBody: TRUNCATED_JSON },
];

let adminToken: string;
let userToken: string;

const models: Record<Scenario, { openai: string; anthropic: string; responses: string }> = {
    "empty-body": { openai: "", anthropic: "", responses: "" },
    "html-body": { openai: "", anthropic: "", responses: "" },
    "truncated-json": { openai: "", anthropic: "", responses: "" },
};

async function createVendorAndModel(
    scenario: Scenario,
    format: "openai" | "anthropic" | "responses",
): Promise<string> {
    const vendor = await requestHelper.post(
        "/vendor/create.json",
        {
            type: "other",
            name: `Mock ${scenario} ${format}`,
            token: "test-token",
            urls: { [format]: `${MOCK_BASE}/${scenario}` },
        },
        adminToken,
    );
    const modelName = `nonjson-${scenario}-${format}-${Date.now()}`;
    const created = await requestHelper.post(
        "/model/create.json",
        modelFixtures.createRandomModel(vendor.body.id, modelName),
        adminToken,
    );
    expect(created.status).toBe(200);
    return modelName;
}

describe("非 JSON / 空响应体上游（P1-06）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        userToken = userResponse.body.token;

        for (const { key } of SCENARIOS) {
            models[key].openai = await createVendorAndModel(key, "openai");
            models[key].anthropic = await createVendorAndModel(key, "anthropic");
            models[key].responses = await createVendorAndModel(key, "responses");
        }
    });

    async function expectRecordFailed() {
        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        expect(records.length).toBeGreaterThan(0);
        const record = records[0];
        // 关键断言：不能记 success（修复前的行为）
        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_error");
        expect(Number(record.cost)).toBe(0);
    }

    for (const { key, expectedBody } of SCENARIOS) {
        describe(`${key}`, () => {
            it(`OpenAI：响应原样透传，记录 failed(upstream_error)/cost=0`, async () => {
                const response = await requestHelper.post(
                    "/llm/v1/chat/completions",
                    mockHelper.generateOpenAIChatRequest({ model: models[key].openai, stream: false }),
                    userToken,
                );

                // 不擅自改上游状态码，响应体逐字节一致
                expect(response.status).toBe(200);
                expect(response.body).toBe(expectedBody);

                await expectRecordFailed();
            });

            it(`Anthropic：响应原样透传，记录 failed(upstream_error)/cost=0`, async () => {
                const response = await requestHelper.postWithAnthropicStyleApiKey(
                    "/llm/v1/messages",
                    mockHelper.generateAnthropicMessageRequest({ model: models[key].anthropic }),
                    userToken,
                );

                expect(response.status).toBe(200);
                expect(response.body).toBe(expectedBody);

                await expectRecordFailed();
            });

            it(`Responses：响应原样透传，记录 failed(upstream_error)/cost=0`, async () => {
                const response = await requestHelper.post(
                    "/llm/v1/responses",
                    mockHelper.generateResponsesRequest({ model: models[key].responses }),
                    userToken,
                );

                expect(response.status).toBe(200);
                expect(response.body).toBe(expectedBody);

                await expectRecordFailed();
            });
        });
    }
});
