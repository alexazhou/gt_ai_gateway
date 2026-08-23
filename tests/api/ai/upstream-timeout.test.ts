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

let hangBodyModelName: string;
let hangHeadersModelName: string;
let slowModelName: string;
let trickleModelName: string;
let badDataModelName: string;


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
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(hangHeadersVendor.body.id, hangHeadersModelName),
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


    describe.skipIf(config.TEST_MODE === "worker")("Client disconnect", () => {
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

            await new Promise((resolve) => setTimeout(resolve, 800));

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("client_disconnected");
        }, 15000);
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
        await dbHelper.execute(
            `INSERT INTO record (user_id, model_id, status, tenant_id, start_at, created_at, updated_at)
             VALUES (${testUserId}, ${hangBodyModelId}, 'processing', (SELECT id FROM tenant WHERE name = 'main'), '${twoDaysAgo}', '${now}', '${now}')`,
        );

        const recoverResponse = await requestHelper.post(
            "/record/recover-orphans.json",
            {},
            adminToken,
        );

        expect(recoverResponse.status).toBe(200);
        expect(recoverResponse.body.recovered).toBe(1);

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];

        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("recovered_orphan");
        expect(record.end_at).toBeTruthy();
    }, 15000);
});