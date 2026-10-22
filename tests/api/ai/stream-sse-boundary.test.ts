import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetch } from "undici";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";
import modelFixtures from "../../fixtures/modelFixtures";

/**
 * P1-04 / P1-05 验收门：SSE 读链路的两个边界。
 *
 * - P1-04 多字节 UTF-8 被 chunk 边界切开：`TextDecoder({stream:true})` 必须留住半个字符，
 *   下个 chunk 补齐；EOF 时还要 flush（`decoder.decode()`），否则尾部字节被静默丢弃
 *   （中文内容缺字 / usage 少一截）。
 * - P1-05 上游一直不吐空行：帧切不出来，字节全堆在 remainingBuffer，无上限就会把
 *   isolate 内存吃爆。必须在阈值内按 `sse_parse_error` 收尾并断开上游读。
 *
 * mock 侧新增两条路由：`/chat/completions/split-multibyte`（按**字节**切片写）、
 * `/chat/completions/no-terminator`（只写单换行、永不出现空行）。
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url;
const ROOT_TOKEN = "root-token-123";
/** 缓冲上限压到 4KB，几百毫秒就能撞线；默认 8MB 在测试里等不起 */
const SMALL_BUFFER_BYTES = 4096;
/** 观察窗口：上限生效应远快于此 */
const OBSERVE_WINDOW_MS = 15_000;

let adminToken: string;
let userToken: string;
let multibyteModelName: string;
let floodModelName: string;

const TIMED_OUT = Symbol("timed-out");

/**
 * 读流到结束或窗口耗尽，返回累计文本与是否已结束。
 *
 * 注意两个坑（都踩过）：
 * 1. **不要在超时后丢弃在飞的 read()**：`Promise.race([read, timeout])` 里若超时先到，
 *    read() 之后仍会 resolve 并**吃掉**接下来的 chunk，这块数据就永久丢了 —— 表现为
 *    「客户端只收到最后一条 [DONE]」。这里把在飞的 read 存进 pending 复用。
 * 2. 客户端侧也要用 `TextDecoder({stream:true})`：网关把字节按网络分片送达，
 *    半个 UTF-8 字符落在两个分片里时，逐片新建解码器会解出 U+FFFD（假红）。
 */
async function drainStream(response: any, windowMs: number): Promise<{ text: string; ended: boolean }> {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + windowMs;
    let text = "";
    let ended = false;
    let pending: Promise<any> | null = null;

    while (Date.now() < deadline) {
        if (!pending) pending = reader.read();
        const result = await Promise.race([
            pending,
            new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
        ]);
        if (result === TIMED_OUT) {
            continue; // 保留 pending，别丢数据
        }
        pending = null;
        if (result.done) {
            ended = true;
            break;
        }
        text += decoder.decode(result.value, { stream: true });
    }

    text += decoder.decode();
    reader.cancel().catch(() => {});
    return { text, ended };
}

async function latestRecordByModel(modelId: number, timeoutMs = 10_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const res = await requestHelper.get("/record/latest.json?limit=10", adminToken);
        const list = Array.isArray(res.body) ? res.body : [];
        const mine = list.find((r: any) => r && r.model_id === modelId);
        if (mine && mine.status !== "processing") return mine;
        if (Date.now() >= deadline) return mine ?? null;
        await new Promise((r) => setTimeout(r, 200));
    }
}

describe("SSE 读链路边界（P1-04 / P1-05）", () => {
    let multibyteModelId: number;
    let floodModelId: number;

    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const user = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        userToken = user.body.token;

        const multibyteVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Split Multibyte",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/split-multibyte` },
            },
            adminToken,
        );
        multibyteModelName = `openai-split-multibyte-${Date.now()}`;
        const multibyteModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(multibyteVendor.body.id, multibyteModelName),
            adminToken,
        );
        multibyteModelId = multibyteModel.body.id;

        const floodVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI No Terminator",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/no-terminator` },
            },
            adminToken,
        );
        floodModelName = `openai-no-terminator-${Date.now()}`;
        const floodModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(floodVendor.body.id, floodModelName),
            adminToken,
        );
        floodModelId = floodModel.body.id;
    }, 60000);

    afterAll(async () => {
        await requestHelper.put("/config.json", { sse_max_buffer_bytes: "8388608" }, ROOT_TOKEN);
    });

    it("P1-04：多字节字符被字节级切片切开时，客户端收到的内容不缺字也不出替换符", async () => {
        const response = await fetch(`${config.SERVER_CONFIG.baseUrl}/llm/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
            body: JSON.stringify({
                model: multibyteModelName,
                messages: [{ role: "user", content: "hi" }],
                stream: true,
            }),
        } as any);
        expect(response.status).toBe(200);

        const { text } = await drainStream(response, OBSERVE_WINDOW_MS);

        // 替换符 = 解码器把半个字符当成了非法字节（没留住跨 chunk 的部分）
        expect(text, "出现 U+FFFD：跨 chunk 的多字节字符被切坏了").not.toContain("\uFFFD");
        // 内容必须完整（"中文流式内容测试ABC" 一个字节都不能少）
        const contents = text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .filter((data) => data && data !== "[DONE]")
            .map((data) => {
                try {
                    return JSON.parse(data);
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .map((obj: any) => obj?.choices?.[0]?.delta?.content ?? "");

        expect(contents.join("")).toContain("中文流式内容测试ABC");

        const record = await latestRecordByModel(multibyteModelId);
        expect(record, "记录应已落库").toBeTruthy();
        expect(record.status, "上游干净 EOF 后应正常收尾").toBe("success");
    }, 60000);

    it("P1-05：上游永不吐空行时，在缓冲上限内中止并按 sse_parse_error 收尾", async () => {
        const configResponse = await requestHelper.put(
            "/config.json",
            { sse_max_buffer_bytes: String(SMALL_BUFFER_BYTES) },
            ROOT_TOKEN,
        );
        // 空闲超时保持默认 180s、总时长上限默认 30min：确保窗口内只有缓冲上限能兜住
        await requestHelper.put("/config.json", { upstream_stream_idle_timeout_ms: "180000" }, ROOT_TOKEN);
        expect(configResponse.status).toBe(200);

        const startedAt = Date.now();
        const response = await fetch(`${config.SERVER_CONFIG.baseUrl}/llm/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
            body: JSON.stringify({
                model: floodModelName,
                messages: [{ role: "user", content: "hi" }],
                stream: true,
            }),
        } as any);
        expect(response.status).toBe(200);

        const { ended } = await drainStream(response, OBSERVE_WINDOW_MS);
        const elapsed = Date.now() - startedAt;

        // 上限生效 = 流被网关主动关掉（不是客户端等到窗口耗尽才撒手）
        expect(
            ended,
            `缓冲上限 ${SMALL_BUFFER_BYTES} 字节未生效：${elapsed}ms 内流仍未结束（生产上等价于内存被吃爆）`,
        ).toBe(true);

        const record = await latestRecordByModel(floodModelId);
        expect(record, "记录应已落库").toBeTruthy();
        expect(record.status, "坏流必须收尾，不能停在 processing").toBe("failed");
        expect(record.failed_code).toBe("sse_parse_error");
        expect(record.response_data ?? "").toContain("缓冲上限");
    }, 60000);
});
