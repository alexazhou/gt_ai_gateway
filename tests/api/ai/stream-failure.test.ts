import { describe, it, expect, beforeAll } from "vitest";
import { fetch } from "undici";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";
import modelFixtures from "../../fixtures/modelFixtures";

/**
 * Stream Failure Handling Tests
 *
 * Verifies that failed_code is correctly set when a streaming request ends abnormally:
 * - unknown_error: upstream closed without [DONE] / message_stop / response.completed
 * - upstream_disconnected: upstream destroyed the TCP socket mid-stream
 * - upstream_error: upstream returned a protocol-level SSE error event
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url; // e.g. http://localhost:9999

let testUserToken: string;
let adminToken: string;

// Vendor and model IDs for each failure scenario
let openaiIncompleteModelName: string;
let openaiDisconnectModelName: string;
let anthropicIncompleteModelName: string;
let responsesIncompleteModelName: string;
let responsesClientAnthropicStreamErrorModelName: string;
let anthropicStreamErrorModelName: string;
let responsesStreamFailedModelName: string;
let responsesStreamFailedHangModelName: string;
let responsesFailedBodyModelName: string;
let openaiStreamErrorModelName: string;

// Slow vendors/models for client_disconnected tests
let openaiSlowModelName: string;
let anthropicSlowModelName: string;
let responsesSlowModelName: string;

// Model for the "client disconnects after response.completed" scenario
let responsesCompleteThenHangModelName: string;


describe("Stream Failure Handling", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserToken = userResponse.body.token;

        // --- OpenAI unknown_error vendor/model ---
        const openaiIncompleteVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Incomplete",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/incomplete` },
            },
            adminToken,
        );
        openaiIncompleteModelName = `openai-incomplete-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openaiIncompleteVendor.body.id, openaiIncompleteModelName),
            adminToken,
        );

        // --- OpenAI upstream_disconnected vendor/model ---
        const openaiDisconnectVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Disconnect",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/disconnect` },
            },
            adminToken,
        );
        openaiDisconnectModelName = `openai-disconnect-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openaiDisconnectVendor.body.id, openaiDisconnectModelName),
            adminToken,
        );

        // --- Anthropic unknown_error vendor/model ---
        const anthropicIncompleteVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Anthropic Incomplete",
                token: "test-token",
                urls: { anthropic: `${MOCK_BASE}/messages/incomplete` },
            },
            adminToken,
        );
        anthropicIncompleteModelName = `anthropic-incomplete-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(anthropicIncompleteVendor.body.id, anthropicIncompleteModelName),
            adminToken,
        );

        // --- Responses API unknown_error vendor/model ---
        const responsesIncompleteVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Incomplete",
                token: "test-token",
                urls: { responses: `${MOCK_BASE}/responses/incomplete` },
            },
            adminToken,
        );
        responsesIncompleteModelName = `responses-incomplete-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(responsesIncompleteVendor.body.id, responsesIncompleteModelName),
            adminToken,
        );

        // --- Responses client -> Anthropic upstream SSE error vendor/model ---
        const responsesClientAnthropicErrorVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Anthropic Stream Error For Responses Client",
                token: "test-token",
                urls: { anthropic: `${MOCK_BASE}/messages/stream-error` },
            },
            adminToken,
        );
        responsesClientAnthropicStreamErrorModelName = `responses-client-anthropic-stream-error-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                responsesClientAnthropicErrorVendor.body.id,
                responsesClientAnthropicStreamErrorModelName,
            ),
            adminToken,
        );

        // --- Anthropic client -> Anthropic upstream SSE error (same protocol, no converter) ---
        const anthropicStreamErrorVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Anthropic Stream Error Same Protocol",
                token: "test-token",
                urls: { anthropic: `${MOCK_BASE}/messages/stream-error` },
            },
            adminToken,
        );
        anthropicStreamErrorModelName = `anthropic-stream-error-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                anthropicStreamErrorVendor.body.id,
                anthropicStreamErrorModelName,
            ),
            adminToken,
        );

        // --- Responses client -> Responses upstream mid-stream failure (same protocol) ---
        const responsesStreamFailedVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Stream Failed",
                token: "test-token",
                urls: { responses: `${MOCK_BASE}/responses/stream-failed` },
            },
            adminToken,
        );
        responsesStreamFailedModelName = `responses-stream-failed-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                responsesStreamFailedVendor.body.id,
                responsesStreamFailedModelName,
            ),
            adminToken,
        );

        // --- OpenAI upstream that reports the failure inside a 200 SSE stream ---
        const openaiStreamErrorVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Stream Error",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/stream-error` },
            },
            adminToken,
        );
        openaiStreamErrorModelName = `openai-stream-error-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                openaiStreamErrorVendor.body.id,
                openaiStreamErrorModelName,
            ),
            adminToken,
        );

        // --- Responses upstream that reports a failure and then keeps the connection open ---
        const responsesStreamFailedHangVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Stream Failed Then Hang",
                token: "test-token",
                urls: { responses: `${MOCK_BASE}/responses/stream-failed-hang` },
            },
            adminToken,
        );
        responsesStreamFailedHangModelName = `responses-stream-failed-hang-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                responsesStreamFailedHangVendor.body.id,
                responsesStreamFailedHangModelName,
            ),
            adminToken,
        );

        // --- Responses upstream that reports a failure inside a 200 non-stream body ---
        const responsesFailedBodyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Failed Body",
                token: "test-token",
                urls: { responses: `${MOCK_BASE}/responses/failed-body` },
            },
            adminToken,
        );
        responsesFailedBodyModelName = `responses-failed-body-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                responsesFailedBodyVendor.body.id,
                responsesFailedBodyModelName,
            ),
            adminToken,
        );

        // --- OpenAI slow vendor/model (for client_disconnected tests) ---
        const openaiSlowVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Slow",
                token: "test-token",
                urls: { openai: `${MOCK_BASE}/chat/completions/slow` },
            },
            adminToken,
        );
        openaiSlowModelName = `openai-slow-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openaiSlowVendor.body.id, openaiSlowModelName),
            adminToken,
        );

        // --- Anthropic slow vendor/model ---
        const anthropicSlowVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Anthropic Slow",
                token: "test-token",
                urls: { anthropic: `${MOCK_BASE}/messages/slow` },
            },
            adminToken,
        );
        anthropicSlowModelName = `anthropic-slow-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(anthropicSlowVendor.body.id, anthropicSlowModelName),
            adminToken,
        );

        // --- Responses API slow vendor/model ---
        const responsesSlowVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Slow",
                token: "test-token",
                urls: { responses: `${MOCK_BASE}/responses/slow` },
            },
            adminToken,
        );
        responsesSlowModelName = `responses-slow-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(responsesSlowVendor.body.id, responsesSlowModelName),
            adminToken,
        );

        // --- Responses API "complete then hang" vendor/model ---
        const responsesCompleteThenHangVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Complete Then Hang",
                token: "test-token",
                urls: { responses: `${MOCK_BASE}/responses/complete-then-hang` },
            },
            adminToken,
        );
        responsesCompleteThenHangModelName = `responses-complete-then-hang-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                responsesCompleteThenHangVendor.body.id,
                responsesCompleteThenHangModelName,
            ),
            adminToken,
        );
    });


    describe("OpenAI /llm/v1/chat/completions", () => {
        it("should set failed_code=unknown_error when upstream closes without [DONE]", async () => {
            await requestHelper.post(
                "/llm/v1/chat/completions",
                { model: openaiIncompleteModelName, messages: [{ role: "user", content: "hi" }], stream: true },
                testUserToken,
            );

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("unknown_error");
        }, 15000);

        it("should set failed_code=upstream_disconnected when upstream destroys socket mid-stream", async () => {
            await requestHelper.post(
                "/llm/v1/chat/completions",
                { model: openaiDisconnectModelName, messages: [{ role: "user", content: "hi" }], stream: true },
                testUserToken,
            );

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("upstream_disconnected");
        }, 15000);

        it("should have null failed_code on successful stream", async () => {
            const upstreamConfig = config.getCurrentUpstreamConfig();
            const vendor = await requestHelper.post(
                "/vendor/create.json",
                {
                    type: "other",
                    name: "Mock OpenAI OK",
                    token: "test-token",
                    urls: { openai: upstreamConfig.openai.url },
                },
                adminToken,
            );
            const modelName = `openai-ok-${Date.now()}`;
            await requestHelper.post(
                "/model/create.json",
                modelFixtures.createRandomModel(vendor.body.id, modelName),
                adminToken,
            );

            await requestHelper.post(
                "/llm/v1/chat/completions",
                { model: modelName, messages: [{ role: "user", content: "hi" }], stream: true },
                testUserToken,
            );

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("success");
            expect(record.failed_code).toBeNull();
        }, 15000);

        it("should relay upstream heartbeat comment lines to the client (CRLF stream)", async () => {
            const vendor = await requestHelper.post(
                "/vendor/create.json",
                {
                    type: "other",
                    name: "Mock OpenAI Heartbeat",
                    token: "test-token",
                    urls: { openai: `${MOCK_BASE}/chat/completions/heartbeat` },
                },
                adminToken,
            );
            const heartbeatModelName = `openai-heartbeat-${Date.now()}`;
            await requestHelper.post(
                "/model/create.json",
                modelFixtures.createRandomModel(vendor.body.id, heartbeatModelName),
                adminToken,
            );

            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const res = await fetch(`${baseUrl}/llm/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: heartbeatModelName,
                    messages: [{ role: "user", content: "hi" }],
                    stream: true,
                }),
            } as any);
            expect(res.status).toBe(200);

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let sseText = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseText += decoder.decode(value, { stream: true });
            }

            // CRLF 帧被正确解析：数据事件正常转发
            expect(sseText).toContain("\"content\":\"Hello\"");
            expect(sseText).toContain("\"content\":\" world\"");
            expect(sseText).toContain("data: [DONE]");
            // 心跳注释行原样透传到下游客户端
            expect(sseText).toContain(": hb\n\n");

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];
            expect(record.status).toBe("success");
            expect(record.failed_code).toBeNull();
        }, 15000);
    });


    describe("Anthropic /llm/v1/messages", () => {
        it("should set failed_code=unknown_error when upstream closes without message_stop", async () => {
            await requestHelper.post(
                "/llm/v1/messages",
                {
                    model: anthropicIncompleteModelName,
                    messages: [{ role: "user", content: "hi" }],
                    stream: true,
                    max_tokens: 100,
                },
                testUserToken,
            );

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("unknown_error");
        }, 15000);

        it("should forward the upstream SSE error event to the client", async () => {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const response = await fetch(`${baseUrl}/llm/v1/messages`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: anthropicStreamErrorModelName,
                    messages: [{ role: "user", content: "hi" }],
                    stream: true,
                    max_tokens: 100,
                }),
            } as any);

            expect(response.status).toBe(200);

            const reader = (response.body as any).getReader();
            const decoder = new TextDecoder();
            let sseText = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseText += decoder.decode(value, { stream: true });
            }

            // 上游的 error 事件必须下发给客户端，而不是让客户端只看到一条被截断的流
            expect(sseText).toContain("event: error");
            expect(sseText).toContain("rate_limit_error");
            expect(sseText).toContain("1302");
        }, 15000);
    });


    describe("Responses API /llm/v1/responses", () => {
        it("should set failed_code=unknown_error when upstream closes without response.completed", async () => {
            await requestHelper.post(
                "/llm/v1/responses",
                { model: responsesIncompleteModelName, input: "hi", stream: true },
                testUserToken,
            );

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("unknown_error");
        }, 15000);

        it("should set failed_code=upstream_error when converted Anthropic stream returns an SSE error event", async () => {
            const response = await requestHelper.post(
                "/llm/v1/responses",
                {
                    model: responsesClientAnthropicStreamErrorModelName,
                    input: "hi",
                    stream: true,
                },
                testUserToken,
            );

            expect(response.status).toBe(200);

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("upstream_error");
            expect(record.response_data).toBeTruthy();
            expect(JSON.parse(record.response_data)).toMatchObject({
                type: "error",
                error: {
                    type: "rate_limit_error",
                    code: "1302",
                },
            });
        }, 15000);

        it("should forward response.failed to the client instead of truncating the stream", async () => {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const response = await fetch(`${baseUrl}/llm/v1/responses`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: responsesStreamFailedModelName,
                    input: "hi",
                    stream: true,
                }),
            } as any);

            expect(response.status).toBe(200);

            const reader = (response.body as any).getReader();
            const decoder = new TextDecoder();
            let sseText = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseText += decoder.decode(value, { stream: true });
            }

            // HTTP 是 200，错误只存在于 SSE 体内：必须把 response.failed 透传给客户端
            expect(sseText).toContain("response.failed");
            expect(sseText).toContain("upstream failed mid-stream");

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];
            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("upstream_error");
        }, 15000);

        it("should close the stream after response.completed without waiting for the upstream to close", async () => {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const startedAt = Date.now();
            const response = await fetch(`${baseUrl}/llm/v1/responses`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: responsesCompleteThenHangModelName,
                    input: "hi",
                    stream: true,
                }),
            } as any);

            expect(response.status).toBe(200);

            const reader = (response.body as any).getReader();
            const decoder = new TextDecoder();
            let sseText = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseText += decoder.decode(value, { stream: true });
            }
            const elapsed = Date.now() - startedAt;

            expect(sseText).toContain("response.completed");
            // 上游发完 response.completed 后一直挂着不关连接：网关应就此收尾，
            // 而不是等到空闲超时（默认 180s）才结束客户端的流、才去落库
            expect(elapsed).toBeLessThan(10000);

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            expect(records[0].status).toBe("success");
        }, 15000);

        it("should mark the record failed when a non-stream upstream returns HTTP 200 with a failed body", async () => {
            const response = await requestHelper.post(
                "/llm/v1/responses",
                { model: responsesFailedBodyModelName, input: "hi" },
                testUserToken,
            );

            // 上游给的就是 200 + 失败体：响应原样透传，不擅自改状态码
            expect(response.status).toBe(200);
            expect(response.body.status).toBe("failed");

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            // 失败只存在于响应体里，只看状态码会记成 success
            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("upstream_error");
            expect(record.cost).toBe(0);
        }, 15000);

        it("should close the stream after an upstream error without waiting for the upstream to close", async () => {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const startedAt = Date.now();
            const response = await fetch(`${baseUrl}/llm/v1/responses`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: responsesStreamFailedHangModelName,
                    input: "hi",
                    stream: true,
                }),
            } as any);

            expect(response.status).toBe(200);

            const reader = (response.body as any).getReader();
            const decoder = new TextDecoder();
            let sseText = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseText += decoder.decode(value, { stream: true });
            }
            const elapsed = Date.now() - startedAt;

            // 错误帧照常下发（旁路），但流不应一直挂着等上游
            expect(sseText).toContain("response.failed");
            expect(elapsed).toBeLessThan(10000);

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];
            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("upstream_error");
        }, 15000);
    });


    // ============================================================
    // 跨协议：上游 200 + 错误在 SSE 体内
    //
    // 转换器是客户端看到的唯一通道，而累加器吃的也是转换后的事件——转换器一旦吞掉
    // 上游的错误，客户端只看到一条被截断的流，记录还可能被记成成功并计费。
    //
    // ============================================================

    describe("Cross-protocol upstream failure — error inside a 200 SSE stream", () => {
        async function readStreamText(response: Awaited<ReturnType<typeof fetch>>): Promise<string> {
            const reader = (response.body as any).getReader();
            const decoder = new TextDecoder();
            let text = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                text += decoder.decode(value, { stream: true });
            }
            return text;
        }

        async function expectRecordFailedWithUpstreamError(): Promise<void> {
            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];
            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("upstream_error");
            // 上游的错误体要落进记录（而不是只留一个 unknown_error）
            expect(record.response_data).toContain("upstream failed mid-stream");
        }

        it("should surface an upstream response.failed to an OpenAI client", async () => {
            const response = await fetch(`${config.SERVER_CONFIG.baseUrl}/llm/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: responsesStreamFailedModelName,
                    messages: [{ role: "user", content: "hi" }],
                    stream: true,
                }),
            } as any);

            expect(response.status).toBe(200);
            const sseText = await readStreamText(response);

            // Responses 的 response.failed 必须被翻译成带 error 字段的 chunk
            expect(sseText).toContain("upstream failed mid-stream");

            await expectRecordFailedWithUpstreamError();
        }, 15000);

        it("should surface an upstream response.failed to an Anthropic client", async () => {
            const response = await fetch(`${config.SERVER_CONFIG.baseUrl}/llm/v1/messages`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: responsesStreamFailedModelName,
                    max_tokens: 100,
                    messages: [{ role: "user", content: "hi" }],
                    stream: true,
                }),
            } as any);

            expect(response.status).toBe(200);
            const sseText = await readStreamText(response);

            // 必须被翻译成 Anthropic 的 error 事件
            expect(sseText).toContain("event: error");
            expect(sseText).toContain("upstream failed mid-stream");

            await expectRecordFailedWithUpstreamError();
        }, 15000);

        it("should surface an upstream error chunk to a Responses client without completing the stream", async () => {
            const response = await fetch(`${config.SERVER_CONFIG.baseUrl}/llm/v1/responses`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: openaiStreamErrorModelName,
                    input: "hi",
                    stream: true,
                }),
            } as any);

            expect(response.status).toBe(200);
            const sseText = await readStreamText(response);

            expect(sseText).toContain("upstream failed mid-stream");
            // 上游已经报错：不能补发一个 response.completed 把这条流当成功收尾
            expect(sseText).not.toContain("response.completed");

            await expectRecordFailedWithUpstreamError();

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            expect(records[0].cost).toBe(0);
        }, 15000);
    });


    describe.skipIf(config.TEST_MODE === "worker")("Client disconnect — upstream still running", () => {
        async function abortStreamAfterFirstChunk(
            endpoint: string,
            body: object,
        ): Promise<void> {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const ac = new AbortController();

            const response = await fetch(`${baseUrl}${endpoint}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify(body),
                signal: ac.signal,
            } as any);

            const reader = (response.body as any).getReader();
            // Read at least one chunk to confirm the stream started
            await reader.read();
            // Abort the client connection while upstream is still hanging
            ac.abort();
            reader.cancel().catch(() => {});

            // Give the gateway time to detect the disconnect and update the record
            await new Promise((resolve) => setTimeout(resolve, 800));
        }

        it("should set failed_code=client_disconnected for OpenAI /llm/v1/chat/completions", async () => {
            await abortStreamAfterFirstChunk("/llm/v1/chat/completions", {
                model: openaiSlowModelName,
                messages: [{ role: "user", content: "hi" }],
                stream: true,
            });

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("client_disconnected");
        }, 15000);

        it("should set failed_code=client_disconnected for Anthropic /llm/v1/messages", async () => {
            await abortStreamAfterFirstChunk("/llm/v1/messages", {
                model: anthropicSlowModelName,
                messages: [{ role: "user", content: "hi" }],
                stream: true,
                max_tokens: 100,
            });

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("client_disconnected");
        }, 15000);

        it("should set failed_code=client_disconnected for Responses /llm/v1/responses", async () => {
            await abortStreamAfterFirstChunk("/llm/v1/responses", {
                model: responsesSlowModelName,
                input: "hi",
                stream: true,
            });

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("client_disconnected");
        }, 15000);

        it("should keep status=success when client disconnects after response.completed was already received (Responses)", async () => {
            const baseUrl = config.SERVER_CONFIG.baseUrl;
            const ac = new AbortController();

            const response = await fetch(`${baseUrl}/llm/v1/responses`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    model: responsesCompleteThenHangModelName,
                    input: "hi",
                    stream: true,
                }),
                signal: ac.signal,
            } as any);

            const reader = (response.body as any).getReader();
            const decoder = new TextDecoder();
            let received = "";
            // Keep reading until the client has seen the full response.completed event,
            // even though upstream keeps holding the connection open afterwards.
            while (!received.includes("response.completed")) {
                const { done, value } = await reader.read();
                if (done) break;
                received += decoder.decode(value, { stream: true });
            }

            // Client disconnects right after getting the complete response.
            ac.abort();
            reader.cancel().catch(() => {});

            // Give the gateway time to detect the disconnect and finalize the record
            await new Promise((resolve) => setTimeout(resolve, 800));

            const records = await requestHelper.getFinalizedRecords(adminToken, 1);
            const record = records[0];

            expect(record.status).toBe("success");
            expect(record.failed_code).toBeNull();
            expect(record.response_data).toBeTruthy();
            expect(record.usage).toBeTruthy();
        }, 15000);
    });
});
