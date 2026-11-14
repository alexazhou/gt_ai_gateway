import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fetch } from "undici";
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


/**
 * P2-23 补充看门狗：**「上游挂住不动」时总时长上限不生效**。
 *
 * `stream-max-duration.test.ts` 覆盖的是「上游一直有数据在流」的场景 —— 那时循环每个 chunk
 * 都会回到循环顶部检查 deadline，上限能拦住。
 *
 * 但真正会「记录停在 processing」的是另一种形态：**上游发完几个 chunk 后就挂住不再发**。
 * 此时循环阻塞在 `readChunk(upstreamReader, idleTimeoutMs)` 里（默认空闲超时 180s），
 * deadline 检查根本轮不到 —— 上限要等到 180s 空闲超时才「顺手」生效，等于这条路没被兜住。
 *
 * 正确修法：把剩余额度传进单次读等待，`readChunk(reader, Math.min(idleTimeoutMs, remaining))`，
 * 或对 `read` 做 `raceWithTimeout(remaining)`。
 *
 * 已修（阿张）：单次读等待收窄为 `min(idleTimeoutMs, 剩余总时长额度)`，deadline 到点即可
 * 从 `read()` 里出来；本用例已从 `it.fails` 转为正式断言。窗口只有 3s，不会拖慢套件。
 */

const ROOT_TOKEN = "root-token-123";
const HANG_MAX_DURATION_MS = 800;
const OBSERVE_WINDOW_MS = 3_000;

let hangAdminToken: string;
let hangUserToken: string;
let hangModelName: string;

/** 带客户端超时的单次读：避免「上游一直不发数据」把用例挂死 */
async function readChunkOrTimeout(
    reader: any,
    timeoutMs: number,
): Promise<{ done: boolean; text: string; timedOut: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ done: boolean; text: string; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false, text: "", timedOut: true }), timeoutMs);
    });
    const read = (async () => {
        const { done, value } = await reader.read();
        return { done, text: value ? new TextDecoder().decode(value) : "", timedOut: false };
    })();
    try {
        return await Promise.race([read, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

describe("流式总时长上限对「上游挂住」是否生效（P2-23 看门狗）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        hangAdminToken = await setupAdminUser();

        const user = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            hangAdminToken,
        );
        hangUserToken = user.body.token;

        // 上游发 2 个 chunk 后挂住：既不关连接也不再发数据
        const hangVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Hang After Chunks",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/slow` },
            },
            hangAdminToken,
        );
        hangModelName = `openai-hang-maxdur-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(hangVendor.body.id, hangModelName),
            hangAdminToken,
        );

        const updated = await requestHelper.put(
            "/config.json",
            { stream_max_duration_ms: String(HANG_MAX_DURATION_MS) },
            ROOT_TOKEN,
        );
        expect(updated.status).toBe(200);
        // 空闲超时保持默认 180s：确保窗口内「不会有别的超时顺手把流关掉」
        await requestHelper.put(
            "/config.json",
            { upstream_stream_idle_timeout_ms: "180000" },
            ROOT_TOKEN,
        );
    }, 60000);

    afterAll(async () => {
        await requestHelper.put(
            "/config.json",
            { stream_max_duration_ms: "1800000" },
            ROOT_TOKEN,
        );
    });

    it("上游挂住不发数据时，总时长上限应当在窗口内主动中止并落 failed", async () => {
        const startedAt = Date.now();
        const response = await fetch(
            `${config.SERVER_CONFIG.baseUrl}/llm/v1/chat/completions`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${hangUserToken}`,
                },
                body: JSON.stringify({
                    model: hangModelName,
                    messages: [{ role: "user", content: "hi" }],
                    stream: true,
                }),
            } as any,
        );
        expect(response.status).toBe(200);

        const reader = (response.body as any).getReader();
        let ended = false;
        let received = "";

        // 观察窗口内按 200ms 切片读，累计到窗口上限就停
        while (Date.now() - startedAt < OBSERVE_WINDOW_MS) {
            const chunk = await readChunkOrTimeout(reader, 200);
            if (chunk.timedOut) {
                continue;
            }
            if (chunk.done) {
                ended = true;
                break;
            }
            received += chunk.text;
        }
        reader.cancel().catch(() => {});

        // 期望：窗口内流已被网关主动关闭（当前实现会一直阻塞在 readChunk 里 → 失败）
        expect(received.length).toBeGreaterThan(0);
        expect(ended).toBe(true);

        // 期望：记录已收尾为 failed/upstream_timeout，而不是停在 processing
        const records = await requestHelper.getFinalizedRecords(hangAdminToken, 1);
        expect(records[0]?.status).toBe("failed");
        expect(records[0]?.failed_code).toBe("upstream_timeout");
    }, 30000);
});
