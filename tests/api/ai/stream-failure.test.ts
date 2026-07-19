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
 * - stream_incomplete: upstream closed without [DONE] / message_stop / response.completed
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

        // --- OpenAI stream_incomplete vendor/model ---
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

        // --- Anthropic stream_incomplete vendor/model ---
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

        // --- Responses API stream_incomplete vendor/model ---
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
        it("should set failed_code=stream_incomplete when upstream closes without [DONE]", async () => {
            await requestHelper.post(
                "/llm/v1/chat/completions",
                { model: openaiIncompleteModelName, messages: [{ role: "user", content: "hi" }], stream: true },
                testUserToken,
            );

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("stream_incomplete");
        }, 15000);

        it("should set failed_code=upstream_disconnected when upstream destroys socket mid-stream", async () => {
            await requestHelper.post(
                "/llm/v1/chat/completions",
                { model: openaiDisconnectModelName, messages: [{ role: "user", content: "hi" }], stream: true },
                testUserToken,
            );

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

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

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

            expect(record.status).toBe("success");
            expect(record.failed_code).toBeNull();
        }, 15000);
    });


    describe("Anthropic /llm/v1/messages", () => {
        it("should set failed_code=stream_incomplete when upstream closes without message_stop", async () => {
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

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("stream_incomplete");
        }, 15000);
    });


    describe("Responses API /llm/v1/responses", () => {
        it("should set failed_code=stream_incomplete when upstream closes without response.completed", async () => {
            await requestHelper.post(
                "/llm/v1/responses",
                { model: responsesIncompleteModelName, input: "hi", stream: true },
                testUserToken,
            );

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("stream_incomplete");
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
            expect(typeof response.body).toBe("string");
            expect(response.body).toContain("event: error");
            expect(response.body).toContain("rate_limit_error");

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

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

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

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

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

            expect(record.status).toBe("failed");
            expect(record.failed_code).toBe("client_disconnected");
        }, 15000);

        it("should set failed_code=client_disconnected for Responses /llm/v1/responses", async () => {
            await abortStreamAfterFirstChunk("/llm/v1/responses", {
                model: responsesSlowModelName,
                input: "hi",
                stream: true,
            });

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

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

            const recordRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
            const record = recordRes.body[0];

            expect(record.status).toBe("success");
            expect(record.failed_code).toBeNull();
            expect(record.response_data).toBeTruthy();
            expect(record.usage).toBeTruthy();
        }, 15000);
    });
});
