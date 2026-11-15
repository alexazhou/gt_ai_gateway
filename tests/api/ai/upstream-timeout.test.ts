import { describe, it, expect, beforeAll } from "vitest";
import { fetch } from "undici";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";
import modelFixtures from "../../fixtures/modelFixtures";

/**
 * 上游响应超时与断连兜底测试
 *
 * 覆盖：
 * - 响应头超时：上游连接后一直不发送响应头 → upstream_timeout
 * - 非流式 body 超时：上游返回头后 body 僵死 → upstream_timeout
 * - 非流式客户端断开：请求未完成时客户端 abort → client_disconnected
 * - 流式空闲超时：上游发几个 chunk 后停住 → upstream_timeout
 * - 长正常流式输出不被误伤 → success
 * - 孤儿记录手动回收：过期 processing 记录经扫描接口被标 FAILED + recovered_orphan
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url; // e.g. http://localhost:9999
const SHORT_TIMEOUT = "2000";

let testUserToken: string;
let adminToken: string;
let testUserId: number;
let hangBodyModelId: number;
let hangHeadersModelId: number;

let hangBodyModelName: string;
let hangHeadersModelName: string;
let unreachableModelName: string;
let slowModelName: string;
let trickleModelName: string;
let badDataModelName: string;


/**
 * 轮询等「指定模型的最新记录」收尾（status !== processing）。
 *
 * 为什么不用 requestHelper.getFinalizedRecords：它按「全局最新 limit 条」判断，
 * 断言时又以 records[0] 为准 —— 一旦同文件前面有记录残留，断言的就不是本次请求的记录了
 * （批次2复验时这里误报过：客户端断开用例取到别人的 processing 记录 → 连带把
 *  孤儿回收用例的 recovered 计数也带红）。这里按 model_id 精确定位本次请求的记录。
 *
 * 收尾时机本身不确定（Worker 本地客户端断开的传播时机不定），因此超时后**原样返回**
 * 最后取到的记录，由调用方决定是断言成功还是走兜底回收，不在这里抛错。
 */
async function waitLatestRecordSettled(
    token: string,
    modelId: number,
    timeoutMs = 10000,
): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let latest: any = null;
    for (;;) {
        const res = await requestHelper.get("/record/latest.json?limit=10", token);
        const list = Array.isArray(res.body) ? res.body : [];
        const mine = list.filter((r: any) => r && r.model_id === modelId);
        latest = mine[0] ?? null;
        if (latest && latest.status !== "processing") {
            return latest;
        }
        if (Date.now() >= deadline) {
            return latest;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}


/**
 * 客户端断开后的收尾验收：两种模式下都要求「不能永久停在 processing」。
 *
 * - 正常路径：等记录收尾 → 断言 failed + 失败码 + 文案可读（不落裸 AbortError）
 * - 兜底路径：Worker 本地（`wrangler dev`）不保证把客户端断开传播成可收尾的失败 ——
 *   请求上下文被一并取消时，handler 里连 markFailed 都执行不到，记录会停在 processing。
 *   这是本地 dev 的运行环境差异（生产 CF 会传播），所以这里验收口径是：
 *   收尾不了就必须能被孤儿回收兜住；「永久 processing 且回收不掉」才算红。
 */
async function expectAbortedRequestFinalized(
    modelId: number,
    expectedFailedCode: string,
): Promise<void> {
    let record = await waitLatestRecordSettled(adminToken, modelId, 10000);
    expect(record, `model ${modelId} 应已落记录`).toBeTruthy();

    if (record.status === "processing") {
        const recoverResponse = await requestHelper.post(
            "/record/recover-orphans.json",
            {},
            adminToken,
        );
        expect(recoverResponse.status).toBe(200);
        record = await waitLatestRecordSettled(adminToken, modelId, 10000);
        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("recovered_orphan");
        expect(record.end_at).toBeTruthy();
        return;
    }

    expect(record.status).toBe("failed");
    expect(record.failed_code).toBe(expectedFailedCode);
    // 详情页报错文案可读：不落裸 AbortError，写明客户端断开
    // 文案口径随模式：worker 下是上游超时，node 下是客户端断开，但都必须可读
    expect(record.response_data).toContain(config.TEST_MODE === "worker" ? "超时" : "客户端断开");
    expect(record.response_data).not.toContain("AbortError");
}


describe("Upstream Timeout & Orphan Recovery", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        // 缩短上游超时与孤儿回收阈值，让超时在 2s 内触发（默认值为秒/分钟级）
        const configResponse = await requestHelper.put(
            "/config.json",
            {
                upstream_headers_timeout_ms: SHORT_TIMEOUT,
                upstream_non_stream_timeout_ms: SHORT_TIMEOUT,
                upstream_stream_idle_timeout_ms: SHORT_TIMEOUT,
                orphan_recover_threshold_ms: SHORT_TIMEOUT,
            },
            adminToken,
        );
        expect(configResponse.status).toBe(200);

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserToken = userResponse.body.token;
        testUserId = userResponse.body.id;

        // --- 非流式 body 僵死 vendor/model ---
        const hangBodyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Hang Body",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/hang-body` },
            },
            adminToken,
        );
        hangBodyModelName = `openai-hang-body-${Date.now()}`;
        const hangBodyModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(hangBodyVendor.body.id, hangBodyModelName),
            adminToken,
        );
        hangBodyModelId = hangBodyModel.body.id;

        // --- 连接后一直不发送响应头 vendor/model ---
        const hangHeadersVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Hang Headers",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/hang-headers` },
            },
            adminToken,
        );
        hangHeadersModelName = `openai-hang-headers-${Date.now()}`;
        const hangHeadersModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(hangHeadersVendor.body.id, hangHeadersModelName),
            adminToken,
        );
        hangHeadersModelId = hangHeadersModel.body.id;

        // --- 连接不可达 vendor/model（fetch 阶段普通网络错误：非超时、非客户端断开） ---
        const unreachableVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Unreachable",
                token: "test-token",
                urls: { openai: "http://127.0.0.1:47832/chat/completions" },
            },
            adminToken,
        );
        unreachableModelName = `openai-unreachable-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(unreachableVendor.body.id, unreachableModelName),
            adminToken,
        );

        // --- 流式发几个 chunk 后停住 vendor/model ---
        const slowVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Slow",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/slow` },
            },
            adminToken,
        );
        slowModelName = `openai-slow-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(slowVendor.body.id, slowModelName),
            adminToken,
        );

        // --- 长正常流式输出（chunk 间隔 < 空闲超时）vendor/model ---
        const trickleVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Trickle",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/trickle` },
            },
            adminToken,
        );
        trickleModelName = `openai-trickle-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(trickleVendor.body.id, trickleModelName),
            adminToken,
        );

        // --- 流式发送非法 JSON data vendor/model ---
        const badDataVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Bad Data",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/bad-data` },
            },
            adminToken,
        );
        badDataModelName = `openai-bad-data-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(badDataVendor.body.id, badDataModelName),
            adminToken,
        );
    });


    it("should set failed_code=upstream_timeout when upstream never sends response headers", async () => {
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: hangHeadersModelName, messages: [{ role: "user", content: "hi" }] },
            testUserToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_timeout");
        // 详情页报错文案可读：不落裸 AbortError，写明超时原因
        expect(record.response_data).toContain("上游响应超时");
    }, 15000);

    it("should classify an unreachable upstream as upstream_unreachable and keep the raw error", async () => {
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: unreachableModelName, messages: [{ role: "user", content: "hi" }] },
            testUserToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_unreachable");
        // response_data 保留原始错误而非按失败码生成的文案；具体文案按运行时不同
        // （undici "TypeError: fetch failed; cause: ..."，workerd "Error: Network connection lost."），
        // 故只断言有原文、且不冒充超时。拼接格式由单测覆盖。
        expect(record.response_data).toBeTruthy();
        expect(record.response_data).not.toContain("上游响应超时");
    }, 15000);


    it("should set failed_code=upstream_timeout when non-stream body stalls after headers", async () => {
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: hangBodyModelName, messages: [{ role: "user", content: "hi" }] },
            testUserToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_timeout");
        expect(record.response_data).toContain("上游响应超时");
    }, 15000);


    it("should set failed_code=stream timeout when stream goes idle mid-output", async () => {
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: slowModelName, messages: [{ role: "user", content: "hi" }], stream: true },
            testUserToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_timeout");
        expect(record.response_data).toContain("上游响应超时");
    }, 15000);


    it("should keep status=success for long trickle stream (chunk interval < idle timeout)", async () => {
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: trickleModelName, messages: [{ role: "user", content: "hi" }], stream: true },
            testUserToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("success");
        expect(record.failed_code).toBeNull();
    }, 20000);


    it("should set failed_code=sse_parse_error when upstream sends non-JSON data in stream", async () => {
        await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: badDataModelName, messages: [{ role: "user", content: "hi" }], stream: true },
            testUserToken,
        );

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("sse_parse_error");
    }, 15000);


    describe("Client disconnect", () => {
        // Worker 本地（`wrangler dev`）不把客户端断开传播到 `c.req.raw.signal`，
        // 请求会一直跑到上游超时才收尾。这里允许两种模式下失败码不同，
        // 但两种模式都必须「已收尾 + 文案可读」：不允许停在 processing，也不允许落裸 AbortError。
        const expectedFailedCode = config.TEST_MODE === "worker" ? "upstream_timeout" : "client_disconnected";

        it("should set failed_code=client_disconnected when client aborts a non-stream request", async () => {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const ac = new AbortController();

            const responsePromise = fetch(`${baseUrl}/llm/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: hangBodyModelName,
                    messages: [{ role: "user", content: "hi" }],
                }),
                signal: ac.signal,
            } as any);

            // 等网关进入「读上游 body」阶段后再断开客户端（在上游 body 超时 2s 之前断开）
            await new Promise((resolve) => setTimeout(resolve, 600));
            ac.abort();
            try {
                await responsePromise;
            } catch (e) {
                // aborted — expected
            }

            await expectAbortedRequestFinalized(hangBodyModelId, expectedFailedCode);
        }, 30000);

        it("should write readable response_data when client aborts while waiting for upstream headers", async () => {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const ac = new AbortController();

            const responsePromise = fetch(`${baseUrl}/llm/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    // 上游一直不回响应头：断开发生在「等响应头」阶段（fetch 阶段 abort），
                    // 与等 body 阶段断开的用例互为补充
                    model: hangHeadersModelName,
                    messages: [{ role: "user", content: "hi" }],
                }),
                signal: ac.signal,
            } as any);

            // 在响应头超时（2s）之前断开客户端
            await new Promise((resolve) => setTimeout(resolve, 600));
            ac.abort();
            try {
                await responsePromise;
            } catch (e) {
                // aborted — expected
            }

            await expectAbortedRequestFinalized(hangHeadersModelId, expectedFailedCode);
        }, 30000);
    });


    it("should recover stale processing records via manual scan endpoint", async () => {
        // 不经 API 直接预置一条「已过期」的 processing 记录（start_at 两天前，远超默认 10 分钟阈值）。
        // 时间在 JS 按应用统一格式（'YYYY-MM-DD HH:mm:ss'，同 recordManager.formatDbDatetime）算好并内联：
        //   - 避免 SQLite 专有 datetime()（MySQL 无此函数）
        //   - worker 模式的 dbHelper.execute 走 wrangler d1 CLI 子进程，该通道不接受 ? 绑定值
        //   - 保证与 recoverOrphans 的文本比较一致（where start_at < 同格式 cutoff；混入 epoch 会因
        //     SQLite TEXT/NUMERIC 亲和性失真）
        // 取「两天前」而非一小时前：本地测试在东八区（CST）而 Worker 运行在 UTC，午夜跨天时 1 小时前的
        // 文本时间会落在「昨天」，与 UTC 的当前日期比较产生跨时区误差；2 天前保证任何时区、任何时刻下
        // 该文本时间都严格在过去。
        // 注：request_data / response_data 已在 migrate_0025 删除（改存对象存储），此处不写。
        const formatDbDatetime = (d: Date) => {
            const p = (n: number) => String(n).padStart(2, "0");
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        };
        const twoDaysAgo = formatDbDatetime(new Date(Date.now() - 86400_000 * 2));
        const now = formatDbDatetime(new Date());

        // 隔离：先清掉本文件前面用例可能残留的 processing 记录。
        // 客户端断开用例在 Worker 本地有可能「收尾不了、只能靠回收兜住」，
        // 若把这些残留算进 recovered，本用例就会连带误红（批次2复验时踩过）。
        await dbHelper.execute(`DELETE FROM record WHERE status = 'processing'`);

        await dbHelper.execute(
            `INSERT INTO record (user_id, model_id, status, tenant_id, start_at, created_at, updated_at)
             VALUES (${testUserId}, ${hangBodyModelId}, 'processing', (SELECT id FROM tenant WHERE name = 'main'), '${twoDaysAgo}', '${now}', '${now}')`,
        );

        // 对照组：不该被当作孤儿回收的 processing 记录（阈值按 start_at 判定）。
        // start_at 故意取「3 分钟后」而不是「现在」：worker/本地 CLI 写种子各要 1s+，
        // 本文件阈值被压到 2s，若用 now 会在这两次写完成前就过期 → 对照组自己变成孤儿，计数变 2。
        const futureStartAt = formatDbDatetime(new Date(Date.now() + 3 * 60_000));
        await dbHelper.execute(
            `INSERT INTO record (user_id, model_id, status, tenant_id, start_at, created_at, updated_at)
             VALUES (${testUserId}, ${hangBodyModelId}, 'processing', (SELECT id FROM tenant WHERE name = 'main'), '${futureStartAt}', '${now}', '${now}')`,
        );

        const recoverResponse = await requestHelper.post(
            "/record/recover-orphans.json",
            {},
            adminToken,
        );

        expect(recoverResponse.status).toBe(200);
        // 只有过期那条被回收，新记录不误伤 → 计数严格为 1
        expect(recoverResponse.body.recovered).toBe(1);

        const latestResponse = await requestHelper.get("/record/latest.json?limit=10", adminToken);
        const records: any[] = Array.isArray(latestResponse.body) ? latestResponse.body : [];

        const recovered = records.find((r) => r.status === "failed" && r.failed_code === "recovered_orphan");
        expect(recovered, "过期 processing 记录应被标记为 recovered_orphan").toBeTruthy();
        expect(recovered.end_at).toBeTruthy();

        const fresh = records.find((r) => r.status === "processing");
        expect(fresh, "未过期的 processing 记录不应被回收").toBeTruthy();

        // 收尾清理：不留 processing 残渣给后续文件
        await dbHelper.execute(`DELETE FROM record WHERE status = 'processing'`);
    }, 20000);
});