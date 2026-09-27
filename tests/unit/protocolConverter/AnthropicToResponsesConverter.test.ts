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
import anthropicAccumulator from "../../../src/util/accumulator/anthropicAccumulator";
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

        const funcCall = (result.input as ResponsesInputItem[]).find((item: any) => item.type === "function_call") as any;
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

        const funcOutput = (result.input as ResponsesInputItem[]).find((item: any) => item.type === "function_call_output") as any;
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

        const reasoning = (result.input as ResponsesInputItem[]).find((item: any) => item.type === "reasoning") as any;
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

    it("should convert adaptive thinking + output_config to reasoning effort", () => {
        const baseReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
        };

        const disabledReq: AnthropicRequest = {
            ...baseReq,
            thinking: { type: "disabled" },
        };
        const minimalReq: AnthropicRequest = {
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.MINIMAL },
        };
        const lowReq: AnthropicRequest = {
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.LOW },
        };
        const mediumReq: AnthropicRequest = {
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.MEDIUM },
        };
        const highReq: AnthropicRequest = {
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.HIGH },
        };
        const xhighReq: AnthropicRequest = {
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.XHIGH },
        };

        expect(converter.convertRequest(disabledReq).reasoning).toEqual({ effort: ReasoningEffort.NONE });
        expect(converter.convertRequest(minimalReq).reasoning).toEqual({ effort: ReasoningEffort.MINIMAL });
        expect(converter.convertRequest(lowReq).reasoning).toEqual({ effort: ReasoningEffort.LOW });
        expect(converter.convertRequest(mediumReq).reasoning).toEqual({ effort: ReasoningEffort.MEDIUM });
        expect(converter.convertRequest(highReq).reasoning).toEqual({ effort: ReasoningEffort.HIGH });
        expect(converter.convertRequest(xhighReq).reasoning).toEqual({ effort: ReasoningEffort.XHIGH });
    });

    it("should parse legacy enabled + budget_tokens format for backward compat", () => {
        const baseReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
        };

        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "enabled", budget_tokens: 10000 },
        }).reasoning).toEqual({ effort: ReasoningEffort.HIGH });
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
            usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens: 20,
                total_tokens: 30,
            },
        };

        const result = converter.convertResponse(upstreamRes);

        expect(result.type).toBe("message");
        expect(result.role).toBe("assistant");
        expect(result.content[0]).toEqual({ type: "text", text: "Hello! How can I help?" });
        expect(result.stop_reason).toBe("end_turn");
        expect(result.usage.input_tokens).toBe(6);
        expect(result.usage.output_tokens).toBe(20);
        expect(result.usage.cache_read_input_tokens).toBe(4);
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
                    usage: {
                        input_tokens: 10,
                        input_tokens_details: { cached_tokens: 4 },
                        output_tokens: 20,
                        total_tokens: 30,
                    },
                },
            }),
        );

        expect(events).toHaveLength(2);
        expect(events[0].event).toBe("message_delta");
        expect(events[1].event).toBe("message_stop");

        const deltaData = parseStreamEventData(events, 0);
        expect(deltaData.delta.stop_reason).toBe("end_turn");
        expect(deltaData.usage.input_tokens).toBe(6);
        expect(deltaData.usage.output_tokens).toBe(20);
        expect(deltaData.usage.cache_read_input_tokens).toBe(4);
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

    it("should hand both upstream failure shapes to the client and to the accumulator", () => {
        // Responses 上游的两种失败形态：模型级 response.failed，以及 API 级 error
        const failedEvents = converter.convertStreamEvent(
            JSON.stringify({
                type: "response.failed",
                sequence_number: 4,
                response: {
                    id: "resp_123",
                    status: "failed",
                    error: { code: "server_error", message: "upstream exploded" },
                },
            }),
            "response.failed",
        );
        const apiErrorEvents = converter.convertStreamEvent(
            JSON.stringify({ type: "error", code: "rate_limit_exceeded", message: "slow down" }),
            "error",
        );

        // ① 客户端（Anthropic）必须收到 event: error + Anthropic 形态的错误体：
        //    HTTP 状态已是 200，SSE 体是唯一的错误通道
        const failedError = failedEvents.find((e) => e.event === "error");
        expect(failedError).toBeDefined();
        expect(JSON.parse(failedError!.data)).toEqual({
            type: "error",
            error: { type: "server_error", message: "upstream exploded" },
        });

        const apiError = apiErrorEvents.find((e) => e.event === "error");
        expect(apiError).toBeDefined();
        expect(JSON.parse(apiError!.data)).toEqual({
            type: "error",
            error: { type: "rate_limit_exceeded", message: "slow down" },
        });

        // ② 记账层也必须看得到：runSSELoop 把【转换后】的事件同时喂给客户端格式的累加器，
        //    转换器吞掉错误会让请求被记成成功并计费
        const accumulator = new anthropicAccumulator.AnthropicAccumulator();
        for (const event of [...failedEvents, ...apiErrorEvents]) {
            accumulator.addEvent(event);
        }
        expect(accumulator.isErrored()).toBe(true);
    });
});

// ============================================================
// ConverterFactory - Responses ↔ Anthropic 路由