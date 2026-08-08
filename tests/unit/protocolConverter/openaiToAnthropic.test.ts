/**
 * OpenAI -> Anthropic 协议转换单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ReasoningEffort } from "../../../src/util/protocolConverter/thinkingConfig";
import { ApiFormat } from "../../../src/constants";
import type { AnthropicRequest, AnthropicResponse, OpenAIRequest, ProtocolStreamEvent } from "../../../src/util/protocolConverter/protocolTypes";

function parseStreamEventData(events: ProtocolStreamEvent[], index: number = 0): any {
    return JSON.parse(events[index].data);
}

describe("OpenAIToAnthropicConverter - convertRequest", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    it("should convert a simple text message", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                { role: "user", content: "Hello" },
            ],
            max_tokens: 1024,
        };

        const result = converter.convertRequest(openaiReq) as AnthropicRequest;

        expect(result.model).toBe("gpt-4");
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe("user");
        expect(result.messages[0].content).toBe("Hello");
        expect(result.max_tokens).toBe(1024);
    });

    it("should extract system messages into Anthropic system field", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                { role: "system", content: "You are a helpful assistant." },
                { role: "user", content: "Hello" },
            ],
            max_tokens: 1024,
        };

        const result = converter.convertRequest(openaiReq);

        expect(result.system).toBe("You are a helpful assistant.");
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe("user");
    });

    it("should convert reasoning_content in assistant message to thinking block", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-3-sonnet-20240229",
            messages: [
                {
                    role: "assistant",
                    content: "answer",
                    reasoning_content: "reasoning",
                },
            ],
        };

        const result = converter.convertRequest(openaiReq);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toEqual({
            role: "assistant",
            content: [
                { type: "thinking", thinking: "reasoning" },
                { type: "text", text: "answer" },
            ],
        });
    });

    it("should convert OpenAI tools to Anthropic format", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 1024,
            tools: [
                {
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "Get weather",
                        parameters: { type: "object", properties: { location: { type: "string" } } },
                    },
                },
            ],
        };

        const result = converter.convertRequest(openaiReq);

        expect(result.tools).toHaveLength(1);
        expect(result.tools![0].name).toBe("get_weather");
        expect(result.tools![0].description).toBe("Get weather");
        expect(result.tools![0].input_schema).toEqual({
            type: "object",
            properties: { location: { type: "string" } },
        });
    });

    it("should convert OpenAI tool_calls to Anthropic tool_use content blocks", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                { role: "user", content: "Hello" },
                {
                    role: "assistant",
                    content: "Let me check.",
                    tool_calls: [
                        {
                            id: "call_123",
                            type: "function",
                            function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
                        },
                    ],
                },
            ],
            max_tokens: 1024,
        };

        const result = converter.convertRequest(openaiReq);

        const assistantMsg = result.messages.find((m: any) => m.role === "assistant")!;
        const content = assistantMsg.content as Array<any>;
        expect(content).toHaveLength(2);
        expect(content[0].type).toBe("text");
        expect(content[0].text).toBe("Let me check.");
        expect(content[1].type).toBe("tool_use");
        expect(content[1].id).toBe("call_123");
        expect(content[1].name).toBe("get_weather");
        expect(content[1].input).toEqual({ location: "Tokyo" });
    });

    it("should convert tool messages to tool_result content blocks", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                { role: "user", content: "Hello" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_123",
                            type: "function",
                            function: { name: "get_weather", arguments: '{}' },
                        },
                    ],
                },
                { role: "tool", content: "Sunny, 25°C", tool_call_id: "call_123" },
            ],
            max_tokens: 1024,
        };

        const result = converter.convertRequest(openaiReq);

        // The tool message should be converted to a user message with tool_result
        const toolResultMsg = result.messages.find(
            (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
        );
        expect(toolResultMsg).toBeDefined();
        const toolResultBlock = (toolResultMsg!.content as Array<any>).find((b: any) => b.type === "tool_result");
        expect(toolResultBlock.tool_use_id).toBe("call_123");
        expect(toolResultBlock.content).toBe("Sunny, 25°C");
    });

    it("should convert stop to stop_sequences", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 1024,
            stop: ["END"],
        };

        const result = converter.convertRequest(openaiReq);
        expect(result.stop_sequences).toEqual(["END"]);
    });

    it("should default max_tokens to 32768 if not specified", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
        };

        const result = converter.convertRequest(openaiReq);
        expect(result.max_tokens).toBe(32768);
    });

    it("should use max_completion_tokens when max_tokens is not specified", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
            max_completion_tokens: 2048,
        };

        const result = converter.convertRequest(openaiReq);
        expect(result.max_tokens).toBe(2048);
    });

    it("should combine multiple system messages", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                { role: "system", content: "First" },
                { role: "system", content: "Second" },
                { role: "user", content: "Hello" },
            ],
        };

        const result = converter.convertRequest(openaiReq);
        expect(result.system).toBe("First\n\nSecond");
    });

    it("should convert tool_choice variants", () => {
        const baseReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
        };

        expect(converter.convertRequest({ ...baseReq, tool_choice: "auto" }).tool_choice).toEqual({ type: "auto" });
        expect(converter.convertRequest({ ...baseReq, tool_choice: "required" }).tool_choice).toEqual({ type: "any" });
        expect(converter.convertRequest({ ...baseReq, tool_choice: "none" }).tool_choice).toBeUndefined();
        expect(converter.convertRequest({
            ...baseReq,
            tool_choice: { type: "function", function: { name: "get_weather" } },
        }).tool_choice).toEqual({ type: "tool", name: "get_weather" });
    });

    it("should convert reasoning_effort to Anthropic adaptive thinking + output_config", () => {
        const baseReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
        };

        const noneResult = converter.convertRequest({ ...baseReq, reasoning_effort: ReasoningEffort.NONE });
        expect(noneResult.thinking).toEqual({ type: "disabled" });
        expect(noneResult.output_config).toBeUndefined();

        const minimalResult = converter.convertRequest({ ...baseReq, reasoning_effort: ReasoningEffort.MINIMAL });
        expect(minimalResult.thinking).toEqual({ type: "adaptive" });
        expect(minimalResult.output_config).toEqual({ effort: ReasoningEffort.MINIMAL });

        const lowResult = converter.convertRequest({ ...baseReq, reasoning_effort: ReasoningEffort.LOW });
        expect(lowResult.thinking).toEqual({ type: "adaptive" });
        expect(lowResult.output_config).toEqual({ effort: ReasoningEffort.LOW });

        const mediumResult = converter.convertRequest({ ...baseReq, reasoning_effort: ReasoningEffort.MEDIUM });
        expect(mediumResult.thinking).toEqual({ type: "adaptive" });
        expect(mediumResult.output_config).toEqual({ effort: ReasoningEffort.MEDIUM });

        const highResult = converter.convertRequest({ ...baseReq, reasoning_effort: ReasoningEffort.HIGH });
        expect(highResult.thinking).toEqual({ type: "adaptive" });
        expect(highResult.output_config).toEqual({ effort: ReasoningEffort.HIGH });

        const xhighResult = converter.convertRequest({ ...baseReq, reasoning_effort: ReasoningEffort.XHIGH });
        expect(xhighResult.thinking).toEqual({ type: "adaptive" });
        expect(xhighResult.output_config).toEqual({ effort: ReasoningEffort.XHIGH });
    });

    it("should convert reasoning.effort to Anthropic thinking", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
            reasoning: { effort: ReasoningEffort.HIGH },
        };

        const result = converter.convertRequest(openaiReq);
        expect(result.thinking).toEqual({ type: "adaptive" });
        expect(result.output_config).toEqual({ effort: ReasoningEffort.HIGH });
    });

    it("should preserve raw tool arguments when JSON parsing fails", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_bad",
                            type: "function",
                            function: { name: "bad_tool", arguments: "{ not json }" },
                        },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(openaiReq);
        const assistantMsg = result.messages[0];
        const toolUse = (assistantMsg.content as Array<any>)[0];
        expect(toolUse.input).toEqual({ raw: "{ not json }" });
    });
});

// ============================================================
// 非流式响应转换：Anthropic upstream → OpenAI client
// ============================================================

describe("OpenAIToAnthropicConverter - convertResponse", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    it("should convert a simple text response", () => {
        const anthropicRes: AnthropicResponse = {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello! How can I help you?" }],
            model: "claude-3-sonnet-20240229",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 20 },
        };

        const result = converter.convertResponse(anthropicRes);

        expect(result.object).toBe("chat.completion");
        expect(result.choices[0].message.content).toBe("Hello! How can I help you?");
        expect(result.choices[0].message.role).toBe("assistant");
        expect(result.choices[0].finish_reason).toBe("stop");
        expect(result.usage.prompt_tokens).toBe(10);
        expect(result.usage.completion_tokens).toBe(20);
        expect(result.usage.total_tokens).toBe(30);
    });

    it("should convert tool_use response", () => {
        const anthropicRes: AnthropicResponse = {
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

        const result = converter.convertResponse(anthropicRes);

        expect(result.choices[0].message.content).toBe("Let me check.");
        expect(result.choices[0].message.tool_calls).toHaveLength(1);
        expect(result.choices[0].message.tool_calls![0].id).toBe("toolu_123");
        expect(result.choices[0].message.tool_calls![0].function.name).toBe("get_weather");
        expect(result.choices[0].finish_reason).toBe("tool_calls");
    });

    it("should map stop reasons correctly", () => {
        const testCases = [
            { stop_reason: "end_turn", expected: "stop" },
            { stop_reason: "max_tokens", expected: "length" },
            { stop_reason: "tool_use", expected: "tool_calls" },
        ] as const;

        for (const { stop_reason, expected } of testCases) {
            const res: AnthropicResponse = {
                id: "msg_123",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "test" }],
                model: "claude-3-sonnet-20240229",
                stop_reason: stop_reason,
                usage: { input_tokens: 0, output_tokens: 0 },
            };
            const result = converter.convertResponse(res);
            expect(result.choices[0].finish_reason).toBe(expected);
        }
    });

    it("should handle thinking blocks as reasoning_content", () => {
        const anthropicRes: AnthropicResponse = {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [
                { type: "thinking", thinking: "Let me think about this..." },
                { type: "text", text: "Here's my answer." },
            ],
            model: "claude-3-sonnet-20240229",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 20 },
        };

        const result = converter.convertResponse(anthropicRes);
        expect(result.choices[0].message.reasoning_content).toBe("Let me think about this...");
        expect(result.choices[0].message.content).toBe("Here's my answer.");
    });

    it("should use provided request id when converting response", () => {
        const anthropicRes: AnthropicResponse = {
            id: "msg_original",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            model: "claude-3-sonnet-20240229",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
        };

        const result = converter.convertResponse(anthropicRes, "custom-id");
        expect(result.id).toBe("chatcmpl-custom-id");
    });

    it("should return null content for tool-only response", () => {
        const anthropicRes: AnthropicResponse = {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [
                { type: "tool_use", id: "toolu_123", name: "get_weather", input: { location: "Tokyo" } },
            ],
            model: "claude-3-sonnet-20240229",
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 20 },
        };

        const result = converter.convertResponse(anthropicRes);
        expect(result.choices[0].message.content).toBeNull();
        expect(result.choices[0].message.tool_calls).toHaveLength(1);
    });
});

// ============================================================
// 流式转换：Anthropic upstream → OpenAI client
// ============================================================

describe("OpenAIToAnthropicConverter - convertStreamEvent", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC, "claude-3-sonnet-20240229") as OpenAIToAnthropicConverter;
    });

    it("should convert message_start to initial chunk", () => {
        const events = converter.convertStreamEvent(JSON.stringify({
            type: "message_start",
            message: {
                id: "msg_123",
                type: "message",
                role: "assistant",
                content: [],
                model: "claude-3-sonnet-20240229",
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 0 },
            },
        }));

        const chunk = parseStreamEventData(events);
        expect(chunk.choices[0].delta.role).toBe("assistant");
        expect(chunk.model).toBe("claude-3-sonnet-20240229");
    });

    it("should convert text_delta events", () => {
        converter.convertStreamEvent(JSON.stringify({
            type: "message_start",
            message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
        }));

        converter.convertStreamEvent(JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        }));

        const events = converter.convertStreamEvent(JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
        }));
        const chunk = parseStreamEventData(events);

        expect(chunk.choices[0].delta.content).toBe("Hello");
    });

    it("should convert thinking_delta events to reasoning_content", () => {
        converter.convertStreamEvent(JSON.stringify({
            type: "message_start",
            message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
        }));

        const startEvents = converter.convertStreamEvent(JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
        }));
        const deltaEvents = converter.convertStreamEvent(JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reasoning" },
        }));

        expect(parseStreamEventData(startEvents).choices[0].delta.reasoning_content).toBe("");
        expect(parseStreamEventData(deltaEvents).choices[0].delta.reasoning_content).toBe("reasoning");
    });

    it("should convert tool_use stream events to OpenAI tool call deltas", () => {
        converter.convertStreamEvent(JSON.stringify({
            type: "message_start",
            message: { id: "msg_123", role: "assistant", model: "claude-3-sonnet-20240229" },
        }));

        const startEvents = converter.convertStreamEvent(JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_123", name: "get_weather", input: {} },
        }));
        const deltaEvents = converter.convertStreamEvent(JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{\"location\"" },
        }));

        const toolStart = parseStreamEventData(startEvents).choices[0].delta.tool_calls[0];
        expect(toolStart).toMatchObject({
            index: 0,
            id: "toolu_123",
            type: "function",
            function: { name: "get_weather", arguments: "" },
        });

        const toolDelta = parseStreamEventData(deltaEvents).choices[0].delta.tool_calls[0];
        expect(toolDelta.index).toBe(0);
        expect(toolDelta.function.arguments).toBe("{\"location\"");
    });

    it("should convert message_delta finish_reason", () => {
        const events = converter.convertStreamEvent(JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 50 },
        }));

        const finalChunk = parseStreamEventData(events);
        expect(finalChunk.choices[0].finish_reason).toBe("stop");
    });

    it("should convert message_stop to OpenAI DONE event", () => {
        const events = converter.convertStreamEvent(JSON.stringify({ type: "message_stop" }));

        expect(events).toEqual([{ data: "[DONE]" }]);
    });

    it("should pass through error stream events", () => {
        const errorData = {
            type: "error",
            error: { type: "rate_limit_error", message: "rate limited" },
        };

        const events = converter.convertStreamEvent(JSON.stringify(errorData));

        expect(events).toEqual([{ event: "error", data: JSON.stringify(errorData) }]);
    });

    it("should return no events for unsupported Anthropic stream event", () => {
        const events = converter.convertStreamEvent(JSON.stringify({ type: "ping" }));

        expect(events).toEqual([]);
    });
});
