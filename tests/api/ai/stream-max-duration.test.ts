import { describe, it, expect, beforeAll, afterAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import mockHelper from "../../helpers/mockHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";
import modelFixtures from "../../fixtures/modelFixtures";

/**
 * P2-23 兜底：流式响应总时长上限（`stream_max_duration_ms`）
 *
 * 背景：流式链路只有「相邻 chunk 空闲超时」，上游一直有数据在流时它不会触发；
 * 而客户端断开在本地 `wrangler dev` 下不会传播到 `c.req.raw.signal`（生产 CF 会），
 * 于是断开后的请求会一直读到上游结束，记录长期停在 `processing`，只能等人工孤儿回收。
 *
 * 契约：
 * - `stream_max_duration_ms > 0` 时，流式响应超过该总时长即中止上游并落库为
 *   `failed / upstream_timeout`，记录**不会**停在 processing；
 * - 触发时远早于空闲超时（本用例把空闲超时设成 5s、总时长上限设成 600ms，
 *   上游每 400ms 一个 chunk，正常路径会一直流下去）。
 */
const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url;
const IDLE_TIMEOUT_MS = "5000";
const MAX_DURATION_MS = "600";

let adminToken: string;
let userToken: string;
let trickleModelName: string;
let previousMaxDuration = "";

describe("流式总时长上限兜底（P2-23）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const configResponse = await requestHelper.put(
            "/config.json",
            {
                upstream_stream_idle_timeout_ms: IDLE_TIMEOUT_MS,
                stream_max_duration_ms: MAX_DURATION_MS,
            },
            adminToken,
        );
        expect(configResponse.status).toBe(200);
        previousMaxDuration = MAX_DURATION_MS;

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        userToken = userResponse.body.token;

        // 上游每 400ms 吐一个 chunk：会一直流下去（间隔 < 空闲超时），只有总时长上限能拦住
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Trickle MaxDuration",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/trickle` },
            },
            adminToken,
        );
        trickleModelName = `openai-trickle-maxduration-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(vendor.body.id, trickleModelName),
            adminToken,
        );
    }, 60000);

    afterAll(async () => {
        // 恢复默认（不影响同进程内后续文件；各文件自己会 truncate）
        if (previousMaxDuration) {
            await requestHelper.put("/config.json", { stream_max_duration_ms: "1800000" }, adminToken);
        }
    });

    it("超过总时长上限时中止上游并落 failed/upstream_timeout，记录不停在 processing", async () => {
        const startedAt = Date.now();
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: trickleModelName, messages: [{ role: "user", content: "hi" }], stream: true },
            userToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1, 4000);
        const record = records[0];

        expect(record).toBeTruthy();
        // 关键断言：不会停在 processing
        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_timeout");
        expect(record.end_at).toBeTruthy();
        // 早于空闲超时（5s）就收尾，说明是总时长上限生效，而不是空闲超时
        expect(Date.now() - startedAt).toBeLessThan(Number(IDLE_TIMEOUT_MS));
    }, 20000);
});
