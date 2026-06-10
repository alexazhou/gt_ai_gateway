import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * Stream Failure Handling Tests
 *
 * Verifies that failed_code is correctly set when a streaming request ends abnormally:
 * - stream_incomplete: upstream closed without [DONE] / message_stop / response.completed
 * - upstream_disconnected: upstream destroyed the TCP socket mid-stream
 */

const MOCK_BASE = config.UPSTREAM_CONFIG.mock.url; // e.g. http://localhost:9999

let testUserToken: string;
let adminToken: string;

// Vendor and model IDs for each failure scenario
let openaiIncompleteModelName: string;
let openaiDisconnectModelName: string;
let anthropicIncompleteModelName: string;
let responsesIncompleteModelName: string;


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
            { name: openaiIncompleteModelName, vendor_id: openaiIncompleteVendor.body.id, enable: true },
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
            { name: openaiDisconnectModelName, vendor_id: openaiDisconnectVendor.body.id, enable: true },
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
            { name: anthropicIncompleteModelName, vendor_id: anthropicIncompleteVendor.body.id, enable: true },
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
            { name: responsesIncompleteModelName, vendor_id: responsesIncompleteVendor.body.id, enable: true },
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
                { name: modelName, vendor_id: vendor.body.id, enable: true },
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
    });
});
