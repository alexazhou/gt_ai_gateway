import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import upstreamCaptureHelper from "../../helpers/upstreamCaptureHelper";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * Protocol conversion API tests
 */

let testUserId: number;
let testUserToken: string;
let adminToken: string;
let openAIClientModelId: number;
let openAIClientModelName: string;
let anthropicClientModelId: number;
let anthropicClientModelName: string;
let responsesErrorModelId: number;
let responsesErrorModelName: string;
let openAIClientResponsesUpstreamModelId: number;
let openAIClientResponsesUpstreamModelName: string;
let responsesClientOpenAIUpstreamModelName: string;


describe("AI Protocol Conversion API", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const userResponse = await requestHelper.post(
            "/user/create.json",
            mockHelper.generateUser(),
            adminToken,
        );
        testUserId = userResponse.body.id;
        testUserToken = userResponse.body.token;

        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;

        const anthropicOnlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Anthropic Only Conversion",
                token: "anthropic-conversion-token",
                urls: { anthropic: `${mockBaseUrl}/messages` },
            },
            adminToken,
        );
        openAIClientModelName = `openai-client-anthropic-upstream-${Date.now()}`;
        const openAIClientModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(anthropicOnlyVendor.body.id, openAIClientModelName),
            adminToken,
        );
        openAIClientModelId = openAIClientModel.body.id;

        const openAIOnlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock OpenAI Only Conversion",
                token: "openai-conversion-token",
                urls: { openai: `${mockBaseUrl}/chat/completions` },
            },
            adminToken,
        );
        anthropicClientModelName = `anthropic-client-openai-upstream-${Date.now()}`;
        const anthropicClientModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(openAIOnlyVendor.body.id, anthropicClientModelName),
            adminToken,
        );
        anthropicClientModelId = anthropicClientModel.body.id;

        // OpenAI URL 默认可派生 responses，导致 Responses 客户端直接命中 responses 上游；
        // 这里用 allowed_formats 限制为 openai，强制走 Responses → OpenAI 转换路径
        const openAIOnlyVendorModel = await requestHelper.post(
            `/vendor/${openAIOnlyVendor.body.id}/model/add.json`,
            { model_id: "openai-only-conversion-model" },
            adminToken,
        );
        await requestHelper.put(
            `/vendor/${openAIOnlyVendor.body.id}/model/${openAIOnlyVendorModel.body.id}.json`,
            { allowed_formats: ["openai"] },
            adminToken,
        );
        responsesClientOpenAIUpstreamModelName = `responses-client-openai-upstream-${Date.now()}`;
        await requestHelper.post(
            "/model/create.json",
            {
                ...modelFixtures.createRandomModel(
                    openAIOnlyVendor.body.id,
                    responsesClientOpenAIUpstreamModelName,
                ),
                routing_config: {
                    upstreams: [{
                        vendor_id: openAIOnlyVendor.body.id,
                        vendor_model_id: openAIOnlyVendorModel.body.id,
                        enabled: true,
                    }],
                },
            },
            adminToken,
        );

        const responsesErrorVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Error Conversion",
                token: "responses-error-conversion-token",
                urls: { responses: `${mockBaseUrl}/responses/error` },
            },
            adminToken,
        );
        const addResponsesVendorModel = await requestHelper.post(
            `/vendor/${responsesErrorVendor.body.id}/model/add.json`,
            { model_id: "unsupported-upstream-model" },
            adminToken,
        );
        await requestHelper.put(
            `/vendor/${responsesErrorVendor.body.id}/model/${addResponsesVendorModel.body.id}.json`,
            { allowed_formats: ["responses"] },
            adminToken,
        );
        responsesErrorModelName = `anthropic-client-responses-error-${Date.now()}`;
        const responsesErrorModel = await requestHelper.post(
            "/model/create.json",
            {
                ...modelFixtures.createRandomModel(responsesErrorVendor.body.id, responsesErrorModelName),
                routing_config: {
                    upstreams: [{
                        vendor_id: responsesErrorVendor.body.id,
                        vendor_model_id: addResponsesVendorModel.body.id,
                        enabled: true,
                    }],
                },
            },
            adminToken,
        );
        responsesErrorModelId = responsesErrorModel.body.id;

        const responsesOnlyVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Only Conversion",
                token: "responses-conversion-token",
                urls: { responses: `${mockBaseUrl}/responses` },
            },
            adminToken,
        );
        openAIClientResponsesUpstreamModelName = `openai-client-responses-upstream-${Date.now()}`;
        const openAIClientResponsesUpstreamModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(
                responsesOnlyVendor.body.id,
                openAIClientResponsesUpstreamModelName,
            ),
            adminToken,
        );
        openAIClientResponsesUpstreamModelId = openAIClientResponsesUpstreamModel.body.id;
    });


    it("should convert OpenAI non-stream request to Anthropic upstream and return OpenAI response", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: openAIClientModelName,
            stream: false,
        });

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            chatRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.object).toBe("chat.completion");
        expect(response.body.choices[0].message.role).toBe("assistant");
        expect(response.body.choices[0].message.content).toContain("mock Claude assistant");
        expect(response.body.usage.prompt_tokens).toBeGreaterThan(0);
        expect(response.body.usage.completion_tokens).toBeGreaterThan(0);

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(openAIClientModelId);
        expect(record.status).toBe("success");

        const responseData = JSON.parse(record.response_data);
        expect(responseData.object).toBe("chat.completion");
        expect(responseData.choices[0].message.content).toBe(response.body.choices[0].message.content);
        expect(responseData.usage.prompt_tokens).toBe(response.body.usage.prompt_tokens);
    }, 30000);


    it("should convert Anthropic non-stream request to OpenAI upstream and return Anthropic response", async () => {
        const messageRequest = mockHelper.generateAnthropicMessageRequest({
            model: anthropicClientModelName,
            stream: false,
        });

        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            messageRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.type).toBe("message");
        expect(response.body.role).toBe("assistant");
        expect(response.body.content[0].type).toBe("text");
        expect(response.body.content[0].text).toContain("mock AI assistant");
        expect(response.body.usage.input_tokens).toBeGreaterThan(0);
        expect(response.body.usage.output_tokens).toBeGreaterThan(0);

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(anthropicClientModelId);
        expect(record.status).toBe("success");

        const responseData = JSON.parse(record.response_data);
        expect(responseData.type).toBe("message");
        expect(responseData.content[0].text).toBe(response.body.content[0].text);
        expect(responseData.usage.input_tokens).toBe(response.body.usage.input_tokens);
    }, 30000);


    it("should forward OpenAI image content as an Anthropic image block", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: openAIClientModelName,
            stream: false,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "描述这张图片" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                    ],
                },
            ],
        });

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            chatRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);

        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => request.json?.model === openAIClientModelName)
            .filter((request) => Array.isArray(request.json?.messages?.[0]?.content)
                && request.json.messages[0].content.some((part: any) => part.type === "image"));
        expect(captured).toHaveLength(1);
        expect(captured[0].json.messages[0].content).toEqual([
            { type: "text", text: "描述这张图片" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ]);
    }, 30000);


    it("should forward Anthropic image content as an OpenAI image_url part", async () => {
        const messageRequest = mockHelper.generateAnthropicMessageRequest({
            model: anthropicClientModelName,
            stream: false,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "描述这张图片" },
                        { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
                    ],
                },
            ],
        });

        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            messageRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);

        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => request.json?.model === anthropicClientModelName)
            .filter((request) => Array.isArray(request.json?.messages?.[0]?.content)
                && request.json.messages[0].content.some((part: any) => part.type === "image_url"));
        expect(captured).toHaveLength(1);
        expect(captured[0].json.messages[0].content).toEqual([
            { type: "text", text: "描述这张图片" },
            { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ]);
    }, 30000);


    it("should convert OpenAI stream request to Anthropic upstream and return OpenAI SSE", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: openAIClientModelName,
            stream: true,
        });

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            chatRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(typeof response.body).toBe("string");
        expect(response.body).toContain("chat.completion.chunk");
        expect(response.body).toContain("[DONE]");
        expect(response.body).not.toContain("message_start");

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(openAIClientModelId);
        expect(record.status).toBe("success");
        const usageA = record.usage;
        expect(usageA.prompt_tokens).toBeGreaterThan(0);
        expect(usageA.completion_tokens).toBeGreaterThan(0);

        const responseData = JSON.parse(record.response_data);
        expect(responseData.choices[0].message.role).toBe("assistant");
        expect(responseData.choices[0].message.content).toContain("mock Claude assistant");
        expect(responseData.usage.prompt_tokens).toBeGreaterThan(0);
    }, 30000);


    it("should convert OpenAI stream request to a Responses upstream and return OpenAI SSE", async () => {
        const chatRequest = mockHelper.generateOpenAIChatRequest({
            model: openAIClientResponsesUpstreamModelName,
            stream: true,
        });

        const response = await requestHelper.post(
            "/llm/v1/chat/completions",
            chatRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(typeof response.body).toBe("string");
        expect(response.body).toContain("chat.completion.chunk");
        expect(response.body).toContain("[DONE]");
        // 客户端协议是 OpenAI，不该看到 Responses 的事件名
        expect(response.body).not.toContain("response.output_text.delta");

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(openAIClientResponsesUpstreamModelId);
        expect(record.status).toBe("success");
        expect(record.upstream_format).toBe("responses");
        expect(record.usage.prompt_tokens).toBeGreaterThan(0);

        const responseData = JSON.parse(record.response_data);
        expect(responseData.choices[0].message.role).toBe("assistant");
        expect(responseData.choices[0].message.content).toBeTruthy();
    }, 30000);


    it("should convert Anthropic stream request to OpenAI upstream and return Anthropic SSE", async () => {
        const messageRequest = mockHelper.generateAnthropicMessageRequest({
            model: anthropicClientModelName,
            stream: true,
        });

        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            messageRequest,
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(typeof response.body).toBe("string");
        expect(response.body).toContain("event: message_start");
        expect(response.body).toContain("event: content_block_delta");
        expect(response.body).toContain("event: message_stop");
        expect(response.body).not.toContain("[DONE]");

        const records = await requestHelper.getFinalizedRecords(adminToken, 1);
        const record = records[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(anthropicClientModelId);
        expect(record.status).toBe("success");
        const usageB = record.usage;

        const responseData = JSON.parse(record.response_data);
        expect(responseData.choices[0].message.role).toBe("assistant");
        expect(responseData.choices[0].message.content).toContain("mock AI assistant");
        expect(responseData.usage.prompt_tokens).toBeGreaterThan(0);
        expect(responseData.usage.completion_tokens).toBeGreaterThan(0);
        expect(usageB.prompt_tokens).toBe(responseData.usage.prompt_tokens);
        expect(usageB.completion_tokens).toBe(responseData.usage.completion_tokens);
        // record.usage 为展示口径：上游未返回缓存时为 null；accumulator 原始 dict 中可能缺省
        expect(usageB.cache_read_tokens).toBe(responseData.usage.cache_read_tokens ?? null);
    }, 30000);


    it("should pass through upstream non-2xx response without protocol conversion", async () => {
        const messageRequest = mockHelper.generateAnthropicMessageRequest({
            model: responsesErrorModelName,
            stream: false,
        });

        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            messageRequest,
            testUserToken,
        );

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: {
                code: "400",
                message: "Param Incorrect",
                param: "Not supported model unsupported-upstream-model",
            },
        });

        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(responsesErrorModelId);
        expect(record.status).toBe("failed");
        expect(JSON.parse(record.response_data)).toEqual(response.body);
    }, 30000);


    it("should use vendor_model allowed_formats when an upstream has no vendor_model_id but a matching vendor_model exists", async () => {
        // This test verifies the auto-matching behavior:
        // When upstream.vendor_model_id is omitted, the system should automatically
        // find a vendor_model with matching name and use its allowed_formats.

        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;

        // 1. Create a vendor that supports both openai and anthropic
        const dualFormatVendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Dual Format Vendor",
                token: "dual-format-token",
                urls: {
                    openai: `${mockBaseUrl}/chat/completions`,
                    anthropic: `${mockBaseUrl}/messages`,
                },
            },
            adminToken,
        );

        // 2. Create a vendor_model with allowed_formats = ["anthropic"] only
        // 用 anthropic 是因为 fallback 优先级为 Responses -> [OpenAI, Anthropic]，
        // 若 allowed_formats 未生效（bug）会回退 vendor 的 [openai, anthropic] 并选中
        // OpenAI（优先级更高），与期望的 anthropic 不同，测试仍能区分
        const vendorModelResponse = await requestHelper.post(
            `/vendor/${dualFormatVendor.body.id}/model/add.json`,
            { model_id: "restricted-model" },
            adminToken,
        );
        await requestHelper.put(
            `/vendor/${dualFormatVendor.body.id}/model/${vendorModelResponse.body.id}.json`,
            { allowed_formats: ["anthropic"] },
            adminToken,
        );

        // 3. Create a model with an automatic upstream (no vendor_model_id)
        // The model name matches the vendor_model's model_id
        const autoModelName = "restricted-model";
        const autoModel = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(dualFormatVendor.body.id, autoModelName),
            adminToken,
        );

        // 4. Send a Responses format request
        // According to the fallback priority: Responses -> [OpenAI, Anthropic]
        // If vendor_model's allowed_formats is properly used, it should pick Anthropic
        // (because allowed_formats = ["anthropic"])
        // If NOT properly used (bug), it falls back to vendor's full format list
        // and picks OpenAI (first in the fallback priority list)
        const responsesRequest = mockHelper.generateOpenAIChatRequest({
            model: autoModelName,
            stream: false,
        });

        // Send as Responses format
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: autoModelName,
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "Hello" }],
                    },
                ],
                stream: false,
            },
            testUserToken,
        );

        // 5. Verify the record's upstream_format
        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];

        // The upstream_format should be "anthropic" (from vendor_model's allowed_formats)
        // NOT "openai" (which would be chosen from vendor's full format list)
        expect(record.upstream_format).toBe("anthropic");
    }, 30000);


    it("should convert a Responses request to an Anthropic upstream", async () => {
        const marker = `responses-to-anthropic-${Date.now()}`;
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: openAIClientModelName,
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: marker }],
                    },
                ],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.object).toBe("response");
        expect(response.body.output[0].content[0].text).toContain("mock Claude assistant");

        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => JSON.stringify(request.json).includes(marker));
        expect(captured).toHaveLength(1);
        expect(captured[0].json.input).toBeUndefined();
        expect(captured[0].json.messages[0].content).toEqual([{ type: "text", text: marker }]);
    }, 30000);


    it("should convert a Responses request to an OpenAI upstream", async () => {
        const marker = `responses-to-openai-${Date.now()}`;
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: responsesClientOpenAIUpstreamModelName,
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: marker }],
                    },
                ],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.object).toBe("response");
        expect(response.body.output[0].content[0].text).toContain("mock AI assistant");

        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => JSON.stringify(request.json).includes(marker));
        expect(captured).toHaveLength(1);
        expect(captured[0].json.input).toBeUndefined();
        expect(captured[0].json.messages[0].content).toBe(marker);
    }, 30000);


    it("should convert an Anthropic request to a Responses upstream", async () => {
        const marker = `anthropic-to-responses-${Date.now()}`;
        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            {
                model: openAIClientResponsesUpstreamModelName,
                max_tokens: 1024,
                messages: [{ role: "user", content: marker }],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.type).toBe("message");
        expect(response.body.content[0].text).toBeTruthy();

        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => Array.isArray(request.json?.input))
            .filter((request) => request.json.input[0]?.content?.[0]?.text === marker);
        expect(captured).toHaveLength(1);
        expect(captured[0].json.messages).toBeUndefined();
    }, 30000);


    it("should forward a Responses tool-result image as an Anthropic tool_result image block", async () => {
        const marker = `responses-tool-image-${Date.now()}`;
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: openAIClientModelName,
                input: [
                    { type: "function_call", call_id: "call_img_1", name: "read_image", arguments: "{}" },
                    {
                        type: "function_call_output",
                        call_id: "call_img_1",
                        output: [
                            { type: "input_text", text: marker },
                            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
                        ],
                    },
                ],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);

        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => Array.isArray(request.json?.messages))
            .filter((request) => request.json.messages.some((message: any) => (
                Array.isArray(message.content)
                && message.content.some((block: any) => block.type === "tool_result"
                    && Array.isArray(block.content)
                    && block.content.some((part: any) => part.type === "image"))
            )));
        expect(captured).toHaveLength(1);
        const toolResult = captured[0].json.messages
            .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
            .find((block: any) => block.type === "tool_result");
        expect(toolResult.content).toEqual([
            { type: "text", text: marker },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ]);
    }, 30000);


    it("should forward an Anthropic tool-result image into an OpenAI user message", async () => {
        const marker = `anthropic-tool-image-${Date.now()}`;
        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            {
                model: anthropicClientModelName,
                max_tokens: 1024,
                messages: [
                    {
                        role: "assistant",
                        content: [{ type: "tool_use", id: "toolu_img_1", name: "read_image", input: {} }],
                    },
                    {
                        role: "user",
                        content: [{
                            type: "tool_result",
                            tool_use_id: "toolu_img_1",
                            content: [
                                { type: "text", text: marker },
                                { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
                            ],
                        }],
                    },
                ],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(200);

        const captured = (await upstreamCaptureHelper.list())
            .filter((request) => Array.isArray(request.json?.messages))
            .filter((request) => request.json.messages.some((message: any) => message.tool_call_id === "toolu_img_1"));
        expect(captured).toHaveLength(1);
        const messages = captured[0].json.messages;
        const toolMessageIndex = messages.findIndex((message: any) => message.tool_call_id === "toolu_img_1");
        expect(messages[toolMessageIndex].content).toBe(marker);
        expect(messages[toolMessageIndex + 1]).toEqual({
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }],
        });
    }, 30000);


    it("should reject Responses input_file when converting to Anthropic", async () => {
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: openAIClientModelName,
                input: [{
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "请总结这个文件" },
                        { type: "input_file", file_data: "AAAA", filename: "report.pdf" },
                    ],
                }],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(400);
        expect(response.body.error.message).toContain("input_file");
    }, 30000);


    it("should reject Responses input_file when converting to OpenAI", async () => {
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: responsesClientOpenAIUpstreamModelName,
                input: [{
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "请总结这个文件" },
                        { type: "input_file", file_data: "AAAA", filename: "report.pdf" },
                    ],
                }],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(400);
        expect(response.body.error.message).toContain("input_file");
    }, 30000);


    it("should reject an invalid Anthropic image source when converting to OpenAI", async () => {
        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            {
                model: anthropicClientModelName,
                max_tokens: 1024,
                messages: [{
                    role: "user",
                    content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }],
                }],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(400);
        expect(response.body.error.message).toContain("source");
    }, 30000);


    it("should finalize the request record as failed when protocol conversion rejects the request", async () => {
        const response = await requestHelper.postWithAnthropicStyleApiKey(
            "/llm/v1/messages",
            {
                model: anthropicClientModelName,
                max_tokens: 1024,
                messages: [{
                    role: "user",
                    content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }],
                }],
                stream: false,
            },
            testUserToken,
        );

        expect(response.status).toBe(400);

        // 转换在发往上游前失败，请求仍是终态失败，不能留下 init / processing 的孤儿记录
        const recordsResponse = await requestHelper.get("/record/latest.json?limit=1", adminToken);
        const record = recordsResponse.body[0];
        expect(record.user_id).toBe(testUserId);
        expect(record.model_id).toBe(anthropicClientModelId);
        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("unknown_error");
        expect(record.end_at).toBeTruthy();
    }, 30000);


    it("routes a Responses client directly to the responses upstream derived from a base openai URL", async () => {
        // vendor 配了 openai（base URL，getUrlByFormat 会自动补全 /chat/completions 后缀 → 可派生 responses）
        // + anthropic；getSupportedFormats 与 getUrlByFormat 口径统一后，responses 应直接路由到 responses 上游，
        // 既不是回退 openai 转换，也不是错误回退到 anthropic
        const mockBaseUrl = config.UPSTREAM_CONFIG.mock.url;
        const vendorResponse = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Mock Responses Priority Vendor",
                token: "responses-priority-token",
                urls: {
                    openai: `${mockBaseUrl}/v1`,
                    anthropic: `${mockBaseUrl}/messages`,
                },
            },
            adminToken,
        );

        const modelName = `responses-priority-model-${Date.now()}`;
        const modelResponse = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(vendorResponse.body.id, modelName),
            adminToken,
        );

        // responses 客户端请求（base openai URL 派生 responses，直接走 responses 上游，无协议转换）
        const response = await requestHelper.post(
            "/llm/v1/responses",
            {
                model: modelName,
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "Hello" }],
                    },
                ],
                stream: false,
            },
            testUserToken,
        );
        expect(response.status).toBe(200);
        expect(response.body.object).toBe("response");

        // 上游格式与客户端格式一致（均为 responses）时，record.upstream_format 记录为 null，
        // 表示直接路由到 responses 而非转换到 openai / 回退到 anthropic
        const recordsResponse = await requestHelper.get(
            `/record/list.json?model_ids=${modelResponse.body.id}`,
            adminToken,
        );
        const record = recordsResponse.body.list[0];
        expect(record.upstream_format).toBeNull();
    }, 30000);
});
