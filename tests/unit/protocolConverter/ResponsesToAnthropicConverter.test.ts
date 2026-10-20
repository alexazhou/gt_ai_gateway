/**
 * Responses API ↔ Anthropic 协议转换单元测试
 *
 * 覆盖：
 * - ResponsesToAnthropicConverter: 请求转换、非流式响应转换、流式事件转换
 * - AnthropicToResponsesConverter: 请求转换、非流式响应转换、流式事件转换
 * - ConverterFactory: Responses ↔ Anthropic 路由
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ResponsesToAnthropicConverter } from "../../../src/util/protocolConverter/ResponsesToAnthropicConverter";
import { AnthropicToResponsesConverter } from "../../../src/util/protocolConverter/AnthropicToResponsesConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ReasoningEffort } from "../../../src/util/protocolConverter/thinkingConfig";
import { ApiFormat } from "../../../src/constants";
import type {
    AnthropicRequest,
    AnthropicResponse,
    AnthropicContentBlock,
    ProtocolStreamEvent,
} from "../../../src/util/protocolConverter/protocolTypes";
import type {
    ResponsesRequest,
    ResponsesNonStreamResponse,
    ResponsesInputItem,
} from "../../../src/util/protocolConverter/responsesTypes";

function parseStreamEventData(events: ProtocolStreamEvent[], index: number = 0): any {
    return JSON.parse(events[index].data);
}

// ============================================================
// ResponsesToAnthropicConverter - 请求转换
// ============================================================

describe("ResponsesToAnthropicConverter - convertRequest", () => {
    let converter: ResponsesToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC) as ResponsesToAnthropicConverter;
    });

    it("should convert a simple text message", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "Hello" }],
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.model).toBe("gpt-4.1");
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe("user");
    });

    it("should convert string input to a user message", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: "Hello",
        };

        const result = converter.convertRequest(req);

        expect(result.model).toBe("gpt-4.1");
        expect(result.messages).toEqual([
            { role: "user", content: "Hello" },
        ]);
    });

    it("should convert instructions to system prompt", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            instructions: "You are a helpful assistant.",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "Hello" }],
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.system).toBe("You are a helpful assistant.");
    });

    it("should convert system message in input to system prompt", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "message",
                    role: "system",
                    content: [{ type: "input_text", text: "System prompt from input" }],
                },
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "Hello" }],
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.system).toBe("System prompt from input");
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe("user");
    });

    it("should convert developer message in input to system prompt", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: "Developer instruction" }],
                },
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "Hello" }],
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.system).toBe("Developer instruction");
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe("user");
    });

    it("should convert function_call to assistant message with tool_use", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "What's the weather?" }],
                },
                {
                    type: "function_call",
                    call_id: "call_123",
                    name: "get_weather",
                    arguments: '{"location":"Tokyo"}',
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.messages).toHaveLength(2);
        const assistantMsg = result.messages[1];
        expect(assistantMsg.role).toBe("assistant");
        const content = assistantMsg.content as AnthropicContentBlock[];
        expect(content).toHaveLength(1);
        expect(content[0].type).toBe("tool_use");
        expect(content[0].id).toBe("call_123");
        expect(content[0].name).toBe("get_weather");
        expect(content[0].input).toEqual({ location: "Tokyo" });
    });

    it("should convert function_call_output to user message with tool_result", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "function_call_output",
                    call_id: "call_123",
                    output: "Sunny, 25°C",
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.messages).toHaveLength(1);
        const userMsg = result.messages[0];
        expect(userMsg.role).toBe("user");
        const content = userMsg.content as AnthropicContentBlock[];
        expect(content).toHaveLength(1);
        expect(content[0].type).toBe("tool_result");
        expect(content[0].tool_use_id).toBe("call_123");
        expect(content[0].content).toBe("Sunny, 25°C");
    });

    it("should convert function_call_output content arrays with images to tool_result blocks", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "function_call_output",
                    call_id: "call_123",
                    output: [
                        { type: "input_text", text: "截图如下" },
                        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
                        { type: "input_image", image_url: "https://example.com/cat.png" },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(req);

        const userMsg = result.messages[0];
        const content = userMsg.content as AnthropicContentBlock[];
        expect(content[0].type).toBe("tool_result");
        expect(content[0].content).toEqual([
            { type: "text", text: "截图如下" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ]);
    });

    it("should convert text-only function_call_output arrays to tool_result text blocks", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "function_call_output",
                    call_id: "call_123",
                    output: [
                        { type: "input_text", text: "第一行" },
                        { type: "output_text", text: "第二行" },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(req);

        const content = result.messages[0].content as AnthropicContentBlock[];
        expect(content[0].content).toEqual([
            { type: "text", text: "第一行" },
            { type: "text", text: "第二行" },
        ]);
    });

    it("should reject function_call_output images that only carry file_id", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "function_call_output",
                    call_id: "call_123",
                    output: [
                        { type: "input_image", file_id: "file-123" },
                    ],
                },
            ],
        };

        expect(() => converter.convertRequest(req)).toThrow(/file_id/);
    });

    it("should convert reasoning item to thinking block", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: "Let me think..." }],
                    encrypted_content: "enc_abc",
                },
                {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Here's my answer." }],
                },
            ],
        };

        const result = converter.convertRequest(req);

        const thinkingMsg = result.messages.find(
            (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "thinking"),
        );
        expect(thinkingMsg).toBeDefined();
        const thinkingBlock = (thinkingMsg!.content as AnthropicContentBlock[]).find((b) => b.type === "thinking")!;
        expect(thinkingBlock.thinking).toBe("Let me think...");
        expect(thinkingBlock.signature).toBe("enc_abc");
    });

    it("should convert tools from Responses format to Anthropic format", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "Hello" }],
                },
            ],
            tools: [
                {
                    type: "function",
                    name: "get_weather",
                    description: "Get weather",
                    parameters: { type: "object", properties: { location: { type: "string" } } },
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.tools).toHaveLength(1);
        expect(result.tools![0].name).toBe("get_weather");
        expect(result.tools![0].description).toBe("Get weather");
        expect(result.tools![0].input_schema).toEqual({
            type: "object",
            properties: { location: { type: "string" } },
        });
    });

    it("should filter out non-function tools (web_search, image_generation, namespace)", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            tools: [
                {
                    type: "function",
                    name: "get_weather",
                    description: "Get weather",
                    parameters: { type: "object", properties: {} },
                },
                {
                    type: "web_search",
                } as any,
                {
                    type: "image_generation",
                } as any,
                {
                    type: "namespace",
                    name: "multi_agent_v1",
                } as any,
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.tools).toHaveLength(1);
        expect(result.tools![0].name).toBe("get_weather");
    });

    it("should convert tool_choice auto to Anthropic format", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            tool_choice: "auto",
        };

        const result = converter.convertRequest(req);
        expect(result.tool_choice).toEqual({ type: "auto" });
    });

    it("should convert tool_choice required to any", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            tool_choice: "required",
        };

        const result = converter.convertRequest(req);
        expect(result.tool_choice).toEqual({ type: "any" });
    });

    it("should not set tool_choice when none", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            tool_choice: "none",
        };

        const result = converter.convertRequest(req);
        expect(result.tool_choice).toBeUndefined();
    });

    it("should convert named function tool_choice", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            tool_choice: { type: "function", name: "get_weather" },
        };

        const result = converter.convertRequest(req);
        expect(result.tool_choice).toEqual({ type: "tool", name: "get_weather" });
    });

    it("should convert reasoning effort to Anthropic adaptive thinking + output_config", () => {
        const baseReq: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
        };

        const noneResult = converter.convertRequest({ ...baseReq, reasoning: { effort: ReasoningEffort.NONE } });
        expect(noneResult.thinking).toEqual({ type: "disabled" });
        expect(noneResult.output_config).toBeUndefined();

        const minimalResult = converter.convertRequest({ ...baseReq, reasoning: { effort: ReasoningEffort.MINIMAL } });
        expect(minimalResult.thinking).toEqual({ type: "adaptive" });
        expect(minimalResult.output_config).toEqual({ effort: ReasoningEffort.MINIMAL });

        const lowResult = converter.convertRequest({ ...baseReq, reasoning: { effort: ReasoningEffort.LOW } });
        expect(lowResult.thinking).toEqual({ type: "adaptive" });
        expect(lowResult.output_config).toEqual({ effort: ReasoningEffort.LOW });

        const mediumResult = converter.convertRequest({ ...baseReq, reasoning: { effort: ReasoningEffort.MEDIUM } });
        expect(mediumResult.thinking).toEqual({ type: "adaptive" });
        expect(mediumResult.output_config).toEqual({ effort: ReasoningEffort.MEDIUM });

        const highResult = converter.convertRequest({ ...baseReq, reasoning: { effort: ReasoningEffort.HIGH } });
        expect(highResult.thinking).toEqual({ type: "adaptive" });
        expect(highResult.output_config).toEqual({ effort: ReasoningEffort.HIGH });

        const xhighResult = converter.convertRequest({ ...baseReq, reasoning: { effort: ReasoningEffort.XHIGH } });
        expect(xhighResult.thinking).toEqual({ type: "adaptive" });
        expect(xhighResult.output_config).toEqual({ effort: ReasoningEffort.XHIGH });
    });

    it("should pass through temperature and top_p", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            temperature: 0.7,
            top_p: 0.9,
        };

        const result = converter.convertRequest(req);
        expect(result.temperature).toBe(0.7);
        expect(result.top_p).toBe(0.9);
    });

    it("should default max_tokens to 32768 when max_output_tokens is not set", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
        };

        const result = converter.convertRequest(req);
        expect(result.max_tokens).toBe(32768);
    });

    it("should use max_output_tokens when set", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            max_output_tokens: 2048,
        };

        const result = converter.convertRequest(req);
        expect(result.max_tokens).toBe(2048);
    });

    it("should handle assistant message with output_text content", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "I can help with that." }],
                },
            ],
        };

        const result = converter.convertRequest(req);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe("assistant");
    });

    it("should handle multiple function_call and function_call_output items in sequence", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "Check weather and time" }] },
                { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"NYC"}' },
                { type: "function_call", call_id: "call_2", name: "get_time", arguments: '{"tz":"EST"}' },
                { type: "function_call_output", call_id: "call_1", output: "Sunny" },
                { type: "function_call_output", call_id: "call_2", output: "10:00" },
            ],
        };

        const result = converter.convertRequest(req);
        // 1 user + 1 assistant (merged tool_use) + 1 user (merged tool_result) = 3
        expect(result.messages).toHaveLength(3);
        // 验证连续的 function_call 被合并到一个 assistant 消息
        expect(result.messages[1].role).toBe("assistant");
        expect(Array.isArray(result.messages[1].content)).toBe(true);
        expect((result.messages[1].content as any[]).length).toBe(2);
        expect((result.messages[1].content as any[])[0].type).toBe("tool_use");
        expect((result.messages[1].content as any[])[1].type).toBe("tool_use");
        // 验证连续的 function_call_output 被合并到一个 user 消息
        expect(result.messages[2].role).toBe("user");
        expect(Array.isArray(result.messages[2].content)).toBe(true);
        expect((result.messages[2].content as any[]).length).toBe(2);
        expect((result.messages[2].content as any[])[0].type).toBe("tool_result");
        expect((result.messages[2].content as any[])[1].type).toBe("tool_result");
    });

    it("should produce valid Anthropic format with multiple tool_use and tool_result", () => {
        // 模拟真实场景：3 个并行 function_call + 3 个 function_call_output
        const req: ResponsesRequest = {
            model: "claude-3-opus",
            input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "Run 3 commands" }] },
                { type: "function_call", call_id: "call_00", name: "exec_command", arguments: '{"cmd":"ls"}' },
                { type: "function_call", call_id: "call_01", name: "exec_command", arguments: '{"cmd":"pwd"}' },
                { type: "function_call", call_id: "call_02", name: "exec_command", arguments: '{"cmd":"whoami"}' },
                { type: "function_call_output", call_id: "call_00", output: "file1.txt\nfile2.txt" },
                { type: "function_call_output", call_id: "call_01", output: "/home/user" },
                { type: "function_call_output", call_id: "call_02", output: "root" },
                { type: "message", role: "user", content: [{ type: "input_text", text: "Done" }] },
            ],
        };

        const result = converter.convertRequest(req);

        // 验证消息结构：user + assistant(3 tool_use) + user(3 tool_result) + user = 4
        expect(result.messages).toHaveLength(4);

        // 验证 assistant 消息包含所有 3 个 tool_use
        const assistantMsg = result.messages[1];
        expect(assistantMsg.role).toBe("assistant");
        expect(Array.isArray(assistantMsg.content)).toBe(true);
        expect((assistantMsg.content as any[]).length).toBe(3);
        expect((assistantMsg.content as any[])[0].type).toBe("tool_use");
        expect((assistantMsg.content as any[])[1].type).toBe("tool_use");
        expect((assistantMsg.content as any[])[2].type).toBe("tool_use");

        // 验证 user 消息包含所有 3 个 tool_result
        const toolResultMsg = result.messages[2];
        expect(toolResultMsg.role).toBe("user");
        expect(Array.isArray(toolResultMsg.content)).toBe(true);
        expect((toolResultMsg.content as any[]).length).toBe(3);
        expect((toolResultMsg.content as any[])[0].type).toBe("tool_result");
        expect((toolResultMsg.content as any[])[1].type).toBe("tool_result");
        expect((toolResultMsg.content as any[])[2].type).toBe("tool_result");

        // 验证 tool_result 的 tool_use_id 正确对应
        expect((toolResultMsg.content as any[])[0].tool_use_id).toBe("call_00");
        expect((toolResultMsg.content as any[])[1].tool_use_id).toBe("call_01");
        expect((toolResultMsg.content as any[])[2].tool_use_id).toBe("call_02");
    });
});

// ============================================================
// ResponsesToAnthropicConverter - 非流式响应转换
// ============================================================

describe("ResponsesToAnthropicConverter - convertResponse", () => {
    let converter: ResponsesToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC) as ResponsesToAnthropicConverter;
    });

    it("should convert a simple text response", () => {
        const upstreamRes: AnthropicResponse = {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello! How can I help?" }],
            model: "claude-3-sonnet-20240229",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 20 },
        };

        const result = converter.convertResponse(upstreamRes);

        expect(result.object).toBe("response");
        expect(result.status).toBe("completed");
        expect(result.model).toBe("claude-3-sonnet-20240229");
        expect(result.output).toHaveLength(1);
        expect(result.output[0].type).toBe("message");
        const msg = result.output[0] as any;
        expect(msg.content[0].type).toBe("output_text");
        expect(msg.content[0].text).toBe("Hello! How can I help?");
        expect(result.usage!.input_tokens).toBe(10);
        expect(result.usage!.output_tokens).toBe(20);
        expect(result.usage!.total_tokens).toBe(30);
    });

    it("should convert tool_use response to function_call output", () => {
        const upstreamRes: AnthropicResponse = {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [
                { type: "text", text: "Let me check." },
                { type: "tool_use", id: "toolu_123", name: "get_weather", input: { location: "Tokyo" } },
            ],
            model: "claude-3-sonnet-20240229",
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 20 },
        };

        const result = converter.convertResponse(upstreamRes);

        expect(result.output).toHaveLength(2);
        const textMsg = result.output.find((o) => o.type === "message") as any;
        expect(textMsg.content[0].text).toBe("Let me check.");

        const funcCall = result.output.find((o) => o.type === "function_call") as any;
        expect(funcCall.name).toBe("get_weather");
        expect(funcCall.call_id).toBe("toolu_123");
        expect(funcCall.arguments).toBe('{"location":"Tokyo"}');
        expect(funcCall.status).toBe("completed");
    });

    it("should convert thinking block to reasoning output", () => {
        const upstreamRes: AnthropicResponse = {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [
                { type: "thinking", thinking: "Let me reason about this...", signature: "sig_abc" },
                { type: "text", text: "Here's my answer." },
            ],
            model: "claude-3-sonnet-20240229",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 20 },
        };

        const result = converter.convertResponse(upstreamRes);

        const reasoning = result.output.find((o) => o.type === "reasoning") as any;
        expect(reasoning).toBeDefined();
        expect(reasoning.summary[0].text).toBe("Let me reason about this...");
        expect(reasoning.encrypted_content).toBe("sig_abc");

        const msg = result.output.find((o) => o.type === "message") as any;
        expect(msg.content[0].text).toBe("Here's my answer.");
    });

    it("should use provided request id", () => {
        const upstreamRes: AnthropicResponse = {
            id: "msg_original",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            model: "claude-3-sonnet-20240229",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
        };

        const result = converter.convertResponse(upstreamRes, "custom_resp_id");
        expect(result.id).toBe("custom_resp_id");
    });

    it("should handle tool-only response (no text)", () => {
        const upstreamRes: AnthropicResponse = {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [
                { type: "tool_use", id: "toolu_456", name: "search", input: { query: "vitest" } },
            ],
            model: "claude-3-sonnet-20240229",
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 20 },
        };

        const result = converter.convertResponse(upstreamRes);

        expect(result.output).toHaveLength(1);
        expect(result.output[0].type).toBe("function_call");
    });
});

// ============================================================
// ResponsesToAnthropicConverter - 流式事件转换
// ============================================================

describe("ResponsesToAnthropicConverter - convertStreamEvent (Anthropic SSE → Responses SSE)", () => {
    let converter: ResponsesToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-sonnet-20240229") as ResponsesToAnthropicConverter;
    });

    it("should convert message_start to response.created + response.in_progress", () => {
        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: {
                    id: "msg_123",
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: "claude-3-sonnet-20240229",
                    usage: { input_tokens: 10, output_tokens: 0 },
                },
            }),
        );

        expect(events.length).toBeGreaterThanOrEqual(2);

        const created = parseStreamEventData(events, 0);
        expect(created.type).toBe("response.created");
        expect(created.response.status).toBe("in_progress");

        const inProgress = parseStreamEventData(events, 1);
        expect(inProgress.type).toBe("response.in_progress");
    });

    it("should convert text content_block_start to output_item.added + content_part.added", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            }),
        );

        expect(events.length).toBeGreaterThanOrEqual(1);
        const added = parseStreamEventData(events, 0);
        expect(added.type).toBe("response.output_item.added");
        expect(added.item.type).toBe("message");
    });

    it("should convert text_delta to response.output_text.delta", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Hello world" },
            }),
        );

        expect(events).toHaveLength(1);
        const delta = parseStreamEventData(events, 0);
        expect(delta.type).toBe("response.output_text.delta");
        expect(delta.delta).toBe("Hello world");
    });

    it("should convert tool_use content_block_start to function_call output_item.added", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "toolu_123", name: "get_weather", input: {} },
            }),
        );

        expect(events.length).toBeGreaterThanOrEqual(1);
        const added = parseStreamEventData(events, 0);
        expect(added.type).toBe("response.output_item.added");
        expect(added.item.type).toBe("function_call");
        expect(added.item.call_id).toBe("toolu_123");
        expect(added.item.name).toBe("get_weather");
    });

    it("should convert input_json_delta to response.function_call_arguments.delta", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "tool_use", id: "toolu_123", name: "get_weather", input: {} },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"location"' },
            }),
        );

        expect(events).toHaveLength(1);
        const delta = parseStreamEventData(events, 0);
        expect(delta.type).toBe("response.function_call_arguments.delta");
        expect(delta.delta).toBe('{"location"');
    });

    it("should convert thinking content_block_start to reasoning output_item.added", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "", signature: "sig_abc" },
            }),
        );

        expect(events.length).toBeGreaterThanOrEqual(1);
        const added = parseStreamEventData(events, 0);
        expect(added.type).toBe("response.output_item.added");
        expect(added.item.type).toBe("reasoning");
    });

    it("should convert thinking_delta to response.reasoning_summary_text.delta", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: "reasoning text" },
            }),
        );

        expect(events).toHaveLength(1);
        const delta = parseStreamEventData(events, 0);
        expect(delta.type).toBe("response.reasoning_summary_text.delta");
        expect(delta.delta).toBe("reasoning text");
    });

    it("should convert message_stop to response.completed with output and usage", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: {
                    id: "msg_123",
                    role: "assistant",
                    model: "claude-3-sonnet-20240229",
                    usage: { input_tokens: 10, output_tokens: 0 },
                },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Hello" },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({ type: "content_block_stop", index: 0 }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 50, input_tokens: 10 },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({ type: "message_stop" }),
        );

        const completedEvent = events.find((e) => {
            const d = JSON.parse(e.data);
            return d.type === "response.completed";
        });
        expect(completedEvent).toBeDefined();
        const completed = JSON.parse(completedEvent!.data);
        expect(completed.response.status).toBe("completed");
        expect(completed.response.usage).toBeDefined();
    });

    it("should return empty for unsupported stream events", () => {
        const events = converter.convertStreamEvent(
            JSON.stringify({ type: "ping" }),
        );

        expect(events).toEqual([]);
    });

    it("should handle error stream event correctly and not swallow it", () => {
        const errorData = {
            type: "error",
            error: {
                type: "rate_limit_error",
                message: "rate limited"
            }
        };
        const events = converter.convertStreamEvent(JSON.stringify(errorData));
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("error");
        expect(JSON.parse(events[0].data)).toEqual(errorData);
    });

    it("should extract cache_read_input_tokens and correctly set input_tokens_details and total_tokens", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_start",
                message: {
                    id: "msg_123",
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: "claude-3-sonnet-20240229",
                    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 0 },
                },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "message_delta",
                delta: { type: "text_delta", text: "" },
                usage: { output_tokens: 20 },
            }),
        );
        const endEvents = converter.convertStreamEvent(
            JSON.stringify({
                type: "message_stop",
            }),
        );

        const completedEvent = endEvents.find(e => {
            if (!e.data) return false;
            try {
                return JSON.parse(e.data).type === "response.completed";
            } catch { return false; }
        });
        expect(completedEvent).toBeDefined();
        const completedData = JSON.parse(completedEvent!.data);
        const usage = completedData.response.usage;
        expect(usage.input_tokens).toBe(10);
        expect(usage.input_tokens_details.cached_tokens).toBe(5);
        expect(usage.output_tokens).toBe(20);
        expect(usage.total_tokens).toBe(35);
    });
});

// ============================================================
// AnthropicToResponsesConverter - 请求转换