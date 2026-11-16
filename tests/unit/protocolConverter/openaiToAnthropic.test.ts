/**
 * OpenAI -> Anthropic 协议转换单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ReasoningEffort } from "../../../src/util/protocol/commonTypes";
import { ApiFormat } from "../../../src/constants";
import type { AnthropicContentBlock, AnthropicRequest, AnthropicResponse } from "../../../src/util/protocol/anthropicTypes";
import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";
import type { OpenAIRequest } from "../../../src/util/protocol/openaiTypes";
import protocolConverterTestUtil from "./protocolConverterTestUtil";

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
        // #295：最后一条 user 的字符串 content 规范化为 text 块并带缓存标记（文本逐字一致）
        expect(result.messages[0].content).toEqual([
            { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
        ]);
        expect(result.max_tokens).toBe(1024);
    });

    it("should convert data-URL image content into an Anthropic base64 image block", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "描述这张图片" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(openaiReq) as AnthropicRequest;

        expect(result.messages[0].content).toEqual([
            { type: "text", text: "描述这张图片" },
            {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAAA" },
                // #295：最后一个可标记块（image）带缓存标记
                cache_control: { type: "ephemeral" },
            },
        ]);
    });

    it("should convert remote image URLs into Anthropic url image blocks", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "描述这张图片" },
                        { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(openaiReq) as AnthropicRequest;

        expect(result.messages[0].content).toEqual([
            { type: "text", text: "描述这张图片" },
            {
                type: "image",
                source: { type: "url", url: "https://example.com/cat.png" },
                // #295：最后一个可标记块（image）带缓存标记
                cache_control: { type: "ephemeral" },
            },
        ]);
    });

    it("should keep text-only content arrays unchanged", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Hello" }],
                },
            ],
        };

        const result = converter.convertRequest(openaiReq) as AnthropicRequest;

        // #295：文本内容与块顺序不变，最后一个可标记块带缓存标记
        expect(result.messages[0].content).toEqual([
            { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
        ]);
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

        // #295：system 字符串规范化为 text 块并带缓存标记（文本逐字一致）
        expect(result.system).toEqual([
            { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
        ]);
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

    it("should merge consecutive user text messages into one user message", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                { role: "user", content: "first" },
                { role: "user", content: "second" },
            ],
            max_tokens: 1024,
        };

        const result = converter.convertRequest(openaiReq);

        expect(result.messages).toHaveLength(1);
        // #295：合并顺序不变，最后一块带缓存标记
        expect(result.messages[0].content).toEqual([
            { type: "text", text: "first" },
            { type: "text", text: "second", cache_control: { type: "ephemeral" } },
        ]);
    });

    it("should merge consecutive tool messages into a single user message", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
                        { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
                    ],
                },
                { role: "tool", content: "Sunny", tool_call_id: "call_1" },
                { role: "tool", content: "10:00", tool_call_id: "call_2" },
            ],
            max_tokens: 1024,
        };

        const result = converter.convertRequest(openaiReq);

        expect(result.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
        const content = result.messages[1].content as AnthropicContentBlock[];
        expect(content).toEqual([
            { type: "tool_result", tool_use_id: "call_1", content: "Sunny" },
            // #295：多个 tool_result 顺序与 tool_use_id 不变，最后一个外层块带缓存标记
            { type: "tool_result", tool_use_id: "call_2", content: "10:00", cache_control: { type: "ephemeral" } },
        ]);
    });

    it("should merge a user message following tool results into the same user message", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [
                { role: "user", content: "What's the weather?" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        { id: "call_123", type: "function", function: { name: "get_weather", arguments: "{}" } },
                    ],
                },
                { role: "tool", content: "Sunny, 25°C", tool_call_id: "call_123" },
                { role: "user", content: "Thanks" },
            ],
            max_tokens: 1024,
        };

        const result = converter.convertRequest(openaiReq);

        expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        const content = result.messages[2].content as AnthropicContentBlock[];
        expect(content).toEqual([
            { type: "tool_result", tool_use_id: "call_123", content: "Sunny, 25°C" },
            // #295：tool_result 与后续 user 文本合并在同一条 user 消息里，最后一块带缓存标记
            { type: "text", text: "Thanks", cache_control: { type: "ephemeral" } },
        ]);
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

    it("should default max_tokens to the safe default 4096 if not specified (P1-07)", () => {
        const openaiReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
        };

        const result = converter.convertRequest(openaiReq);
        expect(result.max_tokens).toBe(4096);
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
        // #295：多条 system 的汇总顺序与分隔符不变，最终 system 块带缓存标记
        expect(result.system).toEqual([
            { type: "text", text: "First\n\nSecond", cache_control: { type: "ephemeral" } },
        ]);
    });

    it("should convert tool_choice variants", () => {
        const baseReq: OpenAIRequest = {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
        };

        expect(converter.convertRequest({ ...baseReq, tool_choice: "auto" }).tool_choice).toEqual({ type: "auto" });
        expect(converter.convertRequest({ ...baseReq, tool_choice: "required" }).tool_choice).toEqual({ type: "any" });
        expect(converter.convertRequest({ ...baseReq, tool_choice: "none" }).tool_choice).toEqual({ type: "none" });
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

        const chunk = protocolConverterTestUtil.parseStreamEventData(events);
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
        const chunk = protocolConverterTestUtil.parseStreamEventData(events);

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

        expect(protocolConverterTestUtil.parseStreamEventData(startEvents).choices[0].delta.reasoning_content).toBe("");
        expect(protocolConverterTestUtil.parseStreamEventData(deltaEvents).choices[0].delta.reasoning_content).toBe("reasoning");
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

        const toolStart = protocolConverterTestUtil.parseStreamEventData(startEvents).choices[0].delta.tool_calls[0];
        expect(toolStart).toMatchObject({
            index: 0,
            id: "toolu_123",
            type: "function",
            function: { name: "get_weather", arguments: "" },
        });

        const toolDelta = protocolConverterTestUtil.parseStreamEventData(deltaEvents).choices[0].delta.tool_calls[0];
        expect(toolDelta.index).toBe(0);
        expect(toolDelta.function.arguments).toBe("{\"location\"");
    });

    it("should convert message_delta finish_reason", () => {
        const events = converter.convertStreamEvent(JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 50 },
        }));

        const finalChunk = protocolConverterTestUtil.parseStreamEventData(events);
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


/**
 * P1-07 验收门：OpenAI → Anthropic 的 `max_tokens` 缺省值与 tool_choice / response_format 组合。
 *
 * 现状（修复前）：`max_tokens: clientReq.max_tokens || clientReq.max_completion_tokens || 32768`。
 * 32768 这个缺省值是「硬顶」而不是「安全缺省」：
 * - 很多 Anthropic 线上模型（尤其带思考的型号）单次输出上限低于 32768，用缺省值直接打过去
 *   会收到 400 `max_tokens: too large`，客户端什么都没干就被拒；
 * - 而 OpenAI 侧本来允许不传 `max_tokens`（普通 chat 请求里非常常见），所以这条路不是边缘场景。
 *
 * 修复方向：未传时取安全缺省（或按 vendor_model 上限钳制），并要求显式传值时原样透传。
 */


/** Anthropic 侧当前所有模型都接受的输出上限（安全缺省必须落在这一档以内） */
const SAFE_MAX_TOKENS_UPPER_BOUND = 8192;

describe("OpenAIToAnthropicConverter - max_tokens 缺省（P1-07）", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    const baseRequest = (overrides: Partial<OpenAIRequest> = {}): OpenAIRequest => ({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
        ...overrides,
    });

    it("未传 max_tokens 时取安全缺省，不能用 32768 这类硬顶", () => {
        const result = converter.convertRequest(baseRequest()) as AnthropicRequest;

        expect(result.max_tokens).toBeGreaterThan(0);
        expect(
            result.max_tokens,
            `未传 max_tokens 时缺省值 ${result.max_tokens} 超过安全档 ${SAFE_MAX_TOKENS_UPPER_BOUND}，低上限模型会直接 400`,
        ).toBeLessThanOrEqual(SAFE_MAX_TOKENS_UPPER_BOUND);
    });

    it("显式 max_tokens 原样透传（不因为是「小值」被抬到缺省）", () => {
        const result = converter.convertRequest(baseRequest({ max_tokens: 128 })) as AnthropicRequest;

        expect(result.max_tokens).toBe(128);
    });

    it("只传 max_completion_tokens（OpenAI 新字段）时按它取值", () => {
        const result = converter.convertRequest(
            baseRequest({ max_completion_tokens: 256 } as Partial<OpenAIRequest>),
        ) as AnthropicRequest;

        expect(result.max_tokens).toBe(256);
    });

    it("max_tokens=0 / 负数等显式非法值 → 400 报错，不静默换成缺省", () => {
        // 合并取舍：master 的 8fc7614 在取缺省值之前加了入参校验（非法值直接 400），
        // 优先级高于本分支原先「非法值静默回落缺省」的写法 —— 客户端显式传了错值就该被明确告知，
        // 静默替换会掩盖调用方的 bug。安全缺省只负责「未传」这一种情况（见上一条用例）。
        for (const invalid of [0, -1]) {
            expect(() => converter.convertRequest(baseRequest({ max_tokens: invalid }))).toThrowError(/positive number/);
        }
    });
});

describe("OpenAIToAnthropicConverter - tool_choice / response_format 组合（P1-07）", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    const tools: OpenAIRequest["tools"] = [
        {
            type: "function",
            function: {
                name: "get_weather",
                description: "get weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
            },
        },
    ];

    it("省略 max_tokens + tool_choice=required + response_format 组合时，转换不炸且各字段都到位", () => {
        const request = {
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "weather in SH?" }],
            tools,
            tool_choice: "required",
            response_format: { type: "json_object" },
        } as unknown as OpenAIRequest;

        const result = converter.convertRequest(request) as AnthropicRequest;

        // max_tokens 仍必须是安全缺省（缺省逻辑不能被组合字段绕过）
        expect(result.max_tokens).toBeGreaterThan(0);
        expect(result.max_tokens).toBeLessThanOrEqual(SAFE_MAX_TOKENS_UPPER_BOUND);
        // tools 与 tool_choice 都要转换到 Anthropic 口径
        expect(result.tools, "tools 必须转换").toHaveLength(1);
        expect(result.tools?.[0].name).toBe("get_weather");
        expect(result.tool_choice).toEqual({ type: "any" });
    });

    it("tool_choice 为对象时映射成具体工具；为 none 时映射成 Anthropic 的 {type:'none'}", () => {
        const withTool = converter.convertRequest({
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "hi" }],
            tools,
            tool_choice: { type: "function", function: { name: "get_weather" } },
        } as unknown as OpenAIRequest) as AnthropicRequest;
        expect(withTool.tool_choice).toEqual({ type: "tool", name: "get_weather" });

        const none = converter.convertRequest({
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "hi" }],
            tools,
            tool_choice: "none",
        } as unknown as OpenAIRequest) as AnthropicRequest;
        // 合并取舍：master 的 8fc7614 把 tool_choice="none" 显式映射成 {type:"none"}
        // （openaiToAnthropic.test.ts / protocolConversionFixes.test.ts 均已按此断言），
        // 本文件原先的「不带 tool_choice」是那之前的口径，随主干统一。
        expect(none.tool_choice).toEqual({ type: "none" });
    });

    it("response_format=json_schema 时不会污染 messages（内容原样保留）", () => {
        const request = {
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "return json" }],
            response_format: {
                type: "json_schema",
                json_schema: { name: "out", schema: { type: "object", properties: {} } },
            },
        } as unknown as OpenAIRequest;

        const result = converter.convertRequest(request) as AnthropicRequest;

        expect(result.messages).toHaveLength(1);
        // #295：response_format 不改内容，仅按缓存规则把最后一条 user 规范化为带标记的 text 块
        expect(result.messages[0].content).toEqual([
            { type: "text", text: "return json", cache_control: { type: "ephemeral" } },
        ]);
        expect(result.max_tokens).toBeLessThanOrEqual(SAFE_MAX_TOKENS_UPPER_BOUND);
    });
});

// ============================================================
// 覆盖率补口：不支持的 content part / 数组型文本内容 / 空 image_url
// ============================================================

describe("OpenAIToAnthropicConverter - 补口判定点", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    it("user 的 content 含不支持的分片类型（input_audio）→ AppError 400，消息带类型名", () => {
        const req = {
            model: "gpt-4",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "听一下" },
                        { type: "input_audio", input_audio: { data: "AAA", format: "wav" } },
                    ],
                },
            ],
        } as unknown as OpenAIRequest;

        expect(() => converter.convertRequest(req)).toThrowError(
            /Unsupported OpenAI content part type for protocol conversion: input_audio/,
        );
        try {
            converter.convertRequest(req);
            throw new Error("应当抛错");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
        }
    });

    it("system 的 content 是数组 → 只取 text 分片并以换行拼接（图片等非文本分片不塞进 system）", () => {
        const req = {
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: [
                        { type: "text", text: "规则一" },
                        { type: "image_url", image_url: { url: "https://x/y.png" } },
                        { type: "text", text: "规则二" },
                    ],
                },
                { role: "user", content: "hi" },
            ],
        } as unknown as OpenAIRequest;

        const result = converter.convertRequest(req) as AnthropicRequest;

        // #295：文本分片仍按换行拼接、图片不塞进 system；拼接结果落在单个 text 块上并带缓存标记
        expect(result.system).toEqual([
            { type: "text", text: "规则一\n规则二", cache_control: { type: "ephemeral" } },
        ]);
    });

    it("tool 消息的 content 是数组 → tool_result 里只拼文本分片", () => {
        const req = {
            model: "gpt-4",
            messages: [
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
                },
                {
                    role: "tool",
                    tool_call_id: "call_1",
                    content: [
                        { type: "text", text: "第 1 行" },
                        { type: "text", text: "第 2 行" },
                    ],
                },
            ],
        } as unknown as OpenAIRequest;

        const result = converter.convertRequest(req) as AnthropicRequest;
        const toolResultMsg = result.messages[result.messages.length - 1];
        const blocks = toolResultMsg.content as AnthropicContentBlock[];

        expect(blocks[0]).toMatchObject({
            type: "tool_result",
            tool_use_id: "call_1",
            content: "第 1 行\n第 2 行",
        });
    });

    it("image_url 分片缺 url（空串 / 对象无 url）→ AppError 400，不生成无源图片块", () => {
        for (const part of [
            { type: "image_url", image_url: { url: "" } },
            { type: "image_url", image_url: {} },
        ]) {
            const req = {
                model: "gpt-4",
                messages: [{ role: "user", content: [part] }],
            } as unknown as OpenAIRequest;

            expect(() => converter.convertRequest(req)).toThrowError(/image_url.url is required/);
            try {
                converter.convertRequest(req);
                throw new Error("应当抛错");
            } catch (e: any) {
                expect(e.statusCode).toBe(400);
            }
        }
    });
});
