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

    it("should convert reasoning effort high to thinking enabled with budget", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            reasoning: { effort: "high" },
        };

        const result = converter.convertRequest(req);
        expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    });

    it("should convert reasoning effort none to thinking disabled", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            reasoning: { effort: "none" },
        };

        const result = converter.convertRequest(req);
        expect(result.thinking).toEqual({ type: "disabled" });
    });

    it("should convert reasoning effort low/medium to thinking enabled with lower budget", () => {
        const reqLow: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            reasoning: { effort: "low" },
        };
        const reqMed: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
            reasoning: { effort: "medium" },
        };

        expect(converter.convertRequest(reqLow).thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
        expect(converter.convertRequest(reqMed).thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
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

    it("should default max_tokens to 4096 when max_output_tokens is not set", () => {
        const req: ResponsesRequest = {
            model: "gpt-4.1",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
        };

        const result = converter.convertRequest(req);
        expect(result.max_tokens).toBe(4096);
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
        // 1 user + 2 assistant (tool_use) + 2 user (tool_result) = 5
        expect(result.messages).toHaveLength(5);
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
});

// ============================================================
// AnthropicToResponsesConverter - 请求转换
// ============================================================

describe("AnthropicToResponsesConverter - convertRequest", () => {
    let converter: AnthropicToResponsesConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES) as AnthropicToResponsesConverter;
    });

    it("should convert a simple text message", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
        };

        const result = converter.convertRequest(req);

        expect(result.model).toBe("claude-3-sonnet-20240229");
        expect(result.max_output_tokens).toBe(1024);
        expect(result.input).toHaveLength(1);
        const msg = result.input[0] as any;
        expect(msg.type).toBe("message");
        expect(msg.role).toBe("user");
        expect(msg.content[0].type).toBe("input_text");
        expect(msg.content[0].text).toBe("Hello");
    });

    it("should convert system string to instructions", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            system: "You are a helpful assistant.",
            messages: [{ role: "user", content: "Hello" }],
        };

        const result = converter.convertRequest(req);

        expect(result.instructions).toBe("You are a helpful assistant.");
    });

    it("should convert system array to instructions", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            system: [
                { type: "text", text: "You are a helpful assistant." },
                { type: "text", text: "Be concise." },
            ],
            messages: [{ role: "user", content: "Hello" }],
        };

        const result = converter.convertRequest(req);

        expect(result.instructions).toBe("You are a helpful assistant.\n\nBe concise.");
    });

    it("should convert assistant message with tool_use to function_call items", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "What's the weather?" },
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Let me check." },
                        { type: "tool_use", id: "toolu_123", name: "get_weather", input: { location: "Tokyo" } },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(req);

        const funcCall = result.input.find((item: any) => item.type === "function_call") as any;
        expect(funcCall).toBeDefined();
        expect(funcCall.call_id).toBe("toolu_123");
        expect(funcCall.name).toBe("get_weather");
        expect(funcCall.arguments).toBe('{"location":"Tokyo"}');
    });

    it("should convert tool_result to function_call_output", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "What's the weather?" },
                {
                    role: "assistant",
                    content: [
                        { type: "tool_use", id: "toolu_123", name: "get_weather", input: { location: "Tokyo" } },
                    ],
                },
                {
                    role: "user",
                    content: [
                        { type: "tool_result", tool_use_id: "toolu_123", content: "Sunny, 25°C" },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(req);

        const funcOutput = result.input.find((item: any) => item.type === "function_call_output") as any;
        expect(funcOutput).toBeDefined();
        expect(funcOutput.call_id).toBe("toolu_123");
        expect(funcOutput.output).toBe("Sunny, 25°C");
    });

    it("should convert thinking block to reasoning item", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "Let me reason...", signature: "sig_abc" },
                        { type: "text", text: "Here's the answer." },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(req);

        const reasoning = result.input.find((item: any) => item.type === "reasoning") as any;
        expect(reasoning).toBeDefined();
        expect(reasoning.summary[0].text).toBe("Let me reason...");
        expect(reasoning.encrypted_content).toBe("sig_abc");
    });

    it("should convert Anthropic tools to Responses format", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            tools: [
                {
                    name: "get_weather",
                    description: "Get weather",
                    input_schema: { type: "object", properties: { location: { type: "string" } } },
                },
            ],
        };

        const result = converter.convertRequest(req);

        expect(result.tools).toHaveLength(1);
        expect(result.tools![0].type).toBe("function");
        expect(result.tools![0].name).toBe("get_weather");
        expect(result.tools![0].description).toBe("Get weather");
        expect(result.tools![0].parameters).toEqual({
            type: "object",
            properties: { location: { type: "string" } },
        });
    });

    it("should convert tool_choice auto to auto", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            tool_choice: { type: "auto" },
        };

        const result = converter.convertRequest(req);
        expect(result.tool_choice).toBe("auto");
    });

    it("should convert tool_choice any to required", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            tool_choice: { type: "any" },
        };

        const result = converter.convertRequest(req);
        expect(result.tool_choice).toBe("required");
    });

    it("should convert named tool_choice to function object", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            tool_choice: { type: "tool", name: "get_weather" },
        };

        const result = converter.convertRequest(req);
        expect(result.tool_choice).toEqual({ type: "function", name: "get_weather" });
    });

    it("should convert thinking enabled to reasoning high", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            thinking: { type: "enabled", budget_tokens: 10000 },
        };

        const result = converter.convertRequest(req);
        expect(result.reasoning).toEqual({ effort: "high" });
    });

    it("should pass through temperature and top_p", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            temperature: 0.5,
            top_p: 0.8,
        };

        const result = converter.convertRequest(req);
        expect(result.temperature).toBe(0.5);
        expect(result.top_p).toBe(0.8);
    });

    it("should pass through stream flag", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            stream: true,
        };

        const result = converter.convertRequest(req);
        expect(result.stream).toBe(true);
    });

    it("should combine multiple system array messages into instructions", () => {
        const req: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            system: [
                { type: "text", text: "First" },
                { type: "text", text: "Second" },
            ],
        };

        const result = converter.convertRequest(req);
        expect(result.instructions).toBe("First\n\nSecond");
    });
});

// ============================================================
// AnthropicToResponsesConverter - 非流式响应转换
// ============================================================

describe("AnthropicToResponsesConverter - convertResponse", () => {
    let converter: AnthropicToResponsesConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES) as AnthropicToResponsesConverter;
    });

    it("should convert a simple text response", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_123",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "message",
                    id: "msg_0",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Hello! How can I help?" }],
                },
            ],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(upstreamRes);

        expect(result.type).toBe("message");
        expect(result.role).toBe("assistant");
        expect(result.content[0]).toEqual({ type: "text", text: "Hello! How can I help?" });
        expect(result.stop_reason).toBe("end_turn");
        expect(result.usage.input_tokens).toBe(10);
        expect(result.usage.output_tokens).toBe(20);
    });

    it("should convert function_call output to tool_use content block", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_123",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "function_call",
                    id: "fc_123",
                    call_id: "call_123",
                    name: "get_weather",
                    arguments: '{"location":"Tokyo"}',
                    status: "completed",
                },
            ],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(upstreamRes);

        const toolUse = result.content.find((b) => b.type === "tool_use")!;
        expect(toolUse.id).toBe("call_123");
        expect(toolUse.name).toBe("get_weather");
        expect(toolUse.input).toEqual({ location: "Tokyo" });
        expect(result.stop_reason).toBe("tool_use");
    });

    it("should convert reasoning output to thinking content block", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_123",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "reasoning",
                    id: "rs_0",
                    encrypted_content: "enc_abc",
                    summary: [{ type: "summary_text", text: "Let me think..." }],
                },
                {
                    type: "message",
                    id: "msg_0",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Here's my answer." }],
                },
            ],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(upstreamRes);

        expect(result.content).toHaveLength(2);
        expect(result.content[0]).toEqual({
            type: "thinking",
            thinking: "Let me think...",
            signature: "enc_abc",
        });
        expect(result.content[1]).toEqual({ type: "text", text: "Here's my answer." });
    });

    it("should map stop_reason to tool_use when function_call present", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_123",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "function_call",
                    id: "fc_123",
                    call_id: "call_123",
                    name: "get_weather",
                    arguments: "{}",
                    status: "completed",
                },
            ],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(upstreamRes);
        expect(result.stop_reason).toBe("tool_use");
    });

    it("should use provided request id", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_original",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "message",
                    id: "msg_0",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Hello" }],
                },
            ],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        };

        const result = converter.convertResponse(upstreamRes, "custom-id");
        expect(result.id).toBe("msg_custom-id");
    });

    it("should format id with msg_ prefix", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_abc",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "message",
                    id: "msg_0",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Hello" }],
                },
            ],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        };

        const result = converter.convertResponse(upstreamRes);
        expect(result.id.startsWith("msg_")).toBe(true);
    });

    it("should handle mixed output items (text + tool_use)", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_123",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "message",
                    id: "msg_0",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Let me check the weather." }],
                },
                {
                    type: "function_call",
                    id: "fc_123",
                    call_id: "call_123",
                    name: "get_weather",
                    arguments: '{"location":"Tokyo"}',
                    status: "completed",
                },
            ],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(upstreamRes);

        expect(result.content).toHaveLength(2);
        expect(result.content[0].type).toBe("text");
        expect(result.content[1].type).toBe("tool_use");
        expect(result.stop_reason).toBe("tool_use");
    });

    it("should return empty object when tool arguments JSON is invalid", () => {
        const upstreamRes: ResponsesNonStreamResponse = {
            id: "resp_123",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "gpt-4.1",
            output: [
                {
                    type: "function_call",
                    id: "fc_123",
                    call_id: "call_123",
                    name: "bad_tool",
                    arguments: "{ not json }",
                    status: "completed",
                },
            ],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        };

        const result = converter.convertResponse(upstreamRes);
        const toolUse = result.content.find((b) => b.type === "tool_use")!;
        // safeParseArgs returns {} on invalid JSON
        expect(toolUse.input).toEqual({});
    });
});

// ============================================================
// AnthropicToResponsesConverter - 流式事件转换
// ============================================================

describe("AnthropicToResponsesConverter - convertStreamEvent (Responses SSE → Anthropic SSE)", () => {
    let converter: AnthropicToResponsesConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES, "gpt-4.1") as AnthropicToResponsesConverter;
    });

    it("should convert response.created to message_start", () => {
        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                sequence_number: 1,
                response: {
                    id: "resp_123",
                    object: "response",
                    status: "in_progress",
                    output: [],
                },
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("message_start");
        const data = parseStreamEventData(events, 0);
        expect(data.type).toBe("message_start");
        expect(data.message.role).toBe("assistant");
        expect(data.message.id).toContain("msg_");
    });

    it("should convert output_item.added (message) to content_block_start", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                sequence_number: 2,
                output_index: 0,
                item: {
                    id: "msg_0",
                    type: "message",
                    status: "in_progress",
                    content: [],
                    role: "assistant",
                },
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_start");
        const data = parseStreamEventData(events, 0);
        expect(data.content_block.type).toBe("text");
    });

    it("should convert output_item.added (function_call) to content_block_start with tool_use", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                sequence_number: 2,
                output_index: 0,
                item: {
                    id: "fc_123",
                    type: "function_call",
                    status: "in_progress",
                    arguments: "",
                    call_id: "call_123",
                    name: "get_weather",
                },
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_start");
        const data = parseStreamEventData(events, 0);
        expect(data.content_block.type).toBe("tool_use");
        expect(data.content_block.id).toBe("call_123");
        expect(data.content_block.name).toBe("get_weather");
    });

    it("should convert output_text.delta to content_block_delta with text_delta", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { id: "msg_0", type: "message", status: "in_progress", content: [], role: "assistant" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_text.delta",
                item_id: "msg_0",
                output_index: 0,
                content_index: 0,
                delta: "Hello",
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_delta");
        const data = parseStreamEventData(events, 0);
        expect(data.delta.type).toBe("text_delta");
        expect(data.delta.text).toBe("Hello");
    });

    it("should convert function_call_arguments.delta to content_block_delta with input_json_delta", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { id: "fc_123", type: "function_call", status: "in_progress", arguments: "", call_id: "call_123", name: "get_weather" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.function_call_arguments.delta",
                item_id: "fc_123",
                output_index: 0,
                delta: '{"location"',
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_delta");
        const data = parseStreamEventData(events, 0);
        expect(data.delta.type).toBe("input_json_delta");
        expect(data.delta.partial_json).toBe('{"location"');
    });

    it("should convert reasoning_summary_text.delta to content_block_delta with thinking_delta", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { id: "rs_0", type: "reasoning", status: "in_progress", summary: [] },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.reasoning_summary_text.delta",
                item_id: "rs_0",
                output_index: 0,
                summary_index: 0,
                delta: "thinking...",
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_delta");
        const data = parseStreamEventData(events, 0);
        expect(data.delta.type).toBe("thinking_delta");
        expect(data.delta.thinking).toBe("thinking...");
    });

    it("should convert function_call_arguments.done to content_block_stop", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { id: "fc_123", type: "function_call", status: "in_progress", arguments: "", call_id: "call_123", name: "get_weather" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.function_call_arguments.done",
                output_index: 0,
                arguments: '{"location":"Tokyo"}',
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_stop");
    });

    it("should convert output_item.done (message) to content_block_stop", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { id: "msg_0", type: "message", status: "in_progress", content: [], role: "assistant" },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.done",
                output_index: 0,
                item: { id: "msg_0", type: "message", status: "completed", content: [{ type: "output_text", text: "Hello" }], role: "assistant" },
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_stop");
    });

    it("should convert output_item.done (reasoning) to content_block_stop", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { id: "rs_0", type: "reasoning", status: "in_progress", summary: [] },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.done",
                output_index: 0,
                item: { id: "rs_0", type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "done" }] },
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("content_block_stop");
    });

    it("should convert response.completed to message_delta + message_stop", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.completed",
                sequence_number: 10,
                response: {
                    id: "resp_123",
                    object: "response",
                    status: "completed",
                    model: "gpt-4.1",
                    output: [
                        {
                            type: "message",
                            id: "msg_0",
                            role: "assistant",
                            status: "completed",
                            content: [{ type: "output_text", text: "Hello" }],
                        },
                    ],
                    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
                },
            }),
        );

        expect(events).toHaveLength(2);
        expect(events[0].event).toBe("message_delta");
        expect(events[1].event).toBe("message_stop");

        const deltaData = parseStreamEventData(events, 0);
        expect(deltaData.delta.stop_reason).toBe("end_turn");
        expect(deltaData.usage.output_tokens).toBe(20);
    });

    it("should set stop_reason to tool_use when function_call in output", () => {
        converter.convertStreamEvent(
            JSON.stringify({
                type: "response.created",
                response: { id: "resp_123", status: "in_progress", output: [] },
            }),
        );

        const events = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.completed",
                response: {
                    id: "resp_123",
                    status: "completed",
                    output: [
                        {
                            type: "function_call",
                            id: "fc_123",
                            call_id: "call_123",
                            name: "get_weather",
                            arguments: "{}",
                            status: "completed",
                        },
                    ],
                    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
                },
            }),
        );

        const deltaData = parseStreamEventData(events, 0);
        expect(deltaData.delta.stop_reason).toBe("tool_use");
    });

    it("should return empty for unsupported Responses stream events", () => {
        const events = converter.convertStreamEvent(
            JSON.stringify({ type: "response.in_progress", response: { id: "resp_123", status: "in_progress" } }),
        );

        expect(events).toEqual([]);
    });
});

// ============================================================
// ConverterFactory - Responses ↔ Anthropic 路由
// ============================================================

describe("ConverterFactory - Responses ↔ Anthropic routing", () => {
    it("should create ResponsesToAnthropicConverter for RESPONSES → ANTHROPIC", () => {
        const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        expect(converter).toBeInstanceOf(ResponsesToAnthropicConverter);
    });

    it("should create AnthropicToResponsesConverter for ANTHROPIC → RESPONSES", () => {
        const converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES);
        expect(converter).toBeInstanceOf(AnthropicToResponsesConverter);
    });

    it("should return null for same format", () => {
        expect(ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.RESPONSES)).toBeNull();
    });

    it("should create pair converter for RESPONSES ↔ ANTHROPIC", () => {
        const pair = ConverterFactory.createPair(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        expect(pair).not.toBeNull();
    });

    it("should still create Anthropic ↔ OpenAI converters", () => {
        const a2o = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const o2a = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        expect(a2o).not.toBeNull();
        expect(o2a).not.toBeNull();
    });
});
