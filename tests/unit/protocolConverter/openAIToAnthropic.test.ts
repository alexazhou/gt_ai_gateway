/**
 * OpenAI -> Anthropic 协议转换单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ApiFormat } from "../../../src/constants";
import type { AnthropicRequest, OpenAIRequest, OpenAIResponse, ProtocolStreamEvent } from "../../../src/util/protocolConverter/protocolTypes";

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

    it("should default max_tokens to 4096 if not specified", () => {
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
// 非流式响应转换：Anthropic → OpenAI
// ============================================================

describe("OpenAIToAnthropicConverter - convertResponse", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    it("should convert a simple text response", () => {
        const openaiRes: OpenAIResponse = {
            id: "chatcmpl-123",
            object: "chat.completion",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "Hello! How can I help you?" },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(openaiRes);

        expect(result.type).toBe("message");
        expect(result.role).toBe("assistant");
        expect(result.content[0]).toEqual({ type: "text", text: "Hello! How can I help you?" });
        expect(result.stop_reason).toBe("end_turn");
        expect(result.usage.input_tokens).toBe(10);
        expect(result.usage.output_tokens).toBe(20);
    });

    it("should convert tool_calls response", () => {
        const openaiRes: OpenAIResponse = {
            id: "chatcmpl-123",
            object: "chat.completion",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_123",
                                type: "function",
                                function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(openaiRes);

        const toolUseBlock = result.content.find((b: any) => b.type === "tool_use")!;
        expect(toolUseBlock.id).toBe("call_123");
        expect(toolUseBlock.name).toBe("get_weather");
        expect(toolUseBlock.input).toEqual({ location: "Tokyo" });
        expect(result.stop_reason).toBe("tool_use");
    });

    it("should map finish reasons correctly", () => {
        const testCases = [
            { finish_reason: "stop", expected: "end_turn" },
            { finish_reason: "length", expected: "max_tokens" },
            { finish_reason: "tool_calls", expected: "tool_use" },
        ] as const;

        for (const { finish_reason, expected } of testCases) {
            const res: OpenAIResponse = {
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "gpt-4",
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: "test" },
                        finish_reason: finish_reason as any,
                    },
                ],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            const result = converter.convertResponse(res);
            expect(result.stop_reason).toBe(expected);
        }
    });

    it("should convert reasoning_content to thinking block", () => {
        const openaiRes: OpenAIResponse = {
            id: "chatcmpl-123",
            object: "chat.completion",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        reasoning_content: "think",
                        content: "answer",
                    },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };

        const result = converter.convertResponse(openaiRes);
        expect(result.content).toEqual([
            { type: "thinking", thinking: "think" },
            { type: "text", text: "answer" },
        ]);
    });

    it("should emit empty text block when response has no content blocks", () => {
        const openaiRes: OpenAIResponse = {
            id: "chatcmpl-123",
            object: "chat.completion",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: null },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        const result = converter.convertResponse(openaiRes);
        expect(result.content).toEqual([{ type: "text", text: "" }]);
    });

    it("should preserve raw tool call arguments when response argument JSON is invalid", () => {
        const openaiRes: OpenAIResponse = {
            id: "chatcmpl-123",
            object: "chat.completion",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    message: {
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
                    finish_reason: "tool_calls",
                },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        const result = converter.convertResponse(openaiRes);
        const toolUse = result.content.find((block: any) => block.type === "tool_use")!;
        expect(toolUse.input).toEqual({ raw: "{ not json }" });
    });

    it("should use provided request id when converting response", () => {
        const openaiRes: OpenAIResponse = {
            id: "chatcmpl-original",
            object: "chat.completion",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "Hello" },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        const result = converter.convertResponse(openaiRes, "custom-id");
        expect(result.id).toBe("msg_custom-id");
    });
});

// ============================================================
// 流式转换：Anthropic → OpenAI
// ============================================================

describe("OpenAIToAnthropicConverter - convertStreamEvent", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC, "gpt-4") as OpenAIToAnthropicConverter;
    });

    it("should convert initial role chunk to message_start", () => {
        const events = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("message_start");
        const parsedData = parseStreamEventData(events);
        expect(parsedData.type).toBe("message_start");
        expect(parsedData.message.role).toBe("assistant");
    });

    it("should convert content delta to content_block_delta", () => {
        // First, send initial chunk to start message
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        // Then send content
        const events = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
        }));

        expect(events.map((event) => event.event)).toEqual(["content_block_start", "content_block_delta"]);
        const startData = parseStreamEventData(events, 0);
        const deltaData = parseStreamEventData(events, 1);
        expect(startData.type).toBe("content_block_start");
        expect(deltaData.type).toBe("content_block_delta");
        expect(deltaData.delta.text).toBe("Hello");
    });

    it("should convert reasoning delta before text delta", () => {
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        const reasoningEvents = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: null }],
        }));

        expect(reasoningEvents.map((event) => event.event)).toEqual(["content_block_start", "content_block_delta"]);
        expect(parseStreamEventData(reasoningEvents, 0).content_block.type).toBe("thinking");
        expect(parseStreamEventData(reasoningEvents, 1).delta.thinking).toBe("thinking");

        const textEvents = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
        }));

        expect(textEvents.map((event) => event.event)).toEqual([
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
        ]);
        expect(parseStreamEventData(textEvents, 1).content_block.type).toBe("text");
        expect(parseStreamEventData(textEvents, 2).delta.text).toBe("answer");
    });

    it("should convert tool call stream events", () => {
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        const startEvents = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_123",
                                type: "function",
                                function: { name: "get_weather", arguments: "" },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        }));

        expect(startEvents.map((event) => event.event)).toEqual(["content_block_start"]);
        const toolStart = parseStreamEventData(startEvents);
        expect(toolStart.content_block).toMatchObject({
            type: "tool_use",
            id: "call_123",
            name: "get_weather",
            input: {},
        });

        const argEvents = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                function: { arguments: "{\"location\"" },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        }));

        expect(argEvents.map((event) => event.event)).toEqual(["content_block_delta"]);
        const toolDelta = parseStreamEventData(argEvents);
        expect(toolDelta.delta).toEqual({
            type: "input_json_delta",
            partial_json: "{\"location\"",
        });
    });

    it("should convert finish_reason to proper stop events", () => {
        // Start message
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        // Send content
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
        }));

        // Finish (no usage in this chunk — usage comes in a separate chunk)
        const finishEvents = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }));

        // message_delta / message_stop are deferred until the usage chunk arrives
        expect(finishEvents.map((event) => event.event)).toEqual(["content_block_stop"]);

        // Usage chunk (stream_options: { include_usage: true })
        const usageEvents = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [],
            usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
        }));

        expect(usageEvents.map((event) => event.event)).toEqual(["message_delta", "message_stop"]);
        expect(parseStreamEventData(usageEvents, 0).type).toBe("message_delta");
        expect(parseStreamEventData(usageEvents, 0).usage.input_tokens).toBe(15);
        expect(parseStreamEventData(usageEvents, 0).usage.output_tokens).toBe(5);
        expect(parseStreamEventData(usageEvents, 1).type).toBe("message_stop");
    });

    it("should normalize input_tokens to non-cached in deferred usage chunk", () => {
        const converter2 = new OpenAIToAnthropicConverter();
        converter2.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123", object: "chat.completion.chunk", created: 1677652288, model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));
        converter2.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123", object: "chat.completion.chunk", created: 1677652288, model: "gpt-4",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }));
        const usageEvents2 = converter2.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123", object: "chat.completion.chunk", created: 1677652288, model: "gpt-4",
            choices: [],
            usage: {
                prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
                prompt_tokens_details: { cached_tokens: 900 },
            },
        }));
        const usageDelta = parseStreamEventData(usageEvents2, 0);
        expect(usageDelta.usage.input_tokens).toBe(100);
        expect(usageDelta.usage.output_tokens).toBe(50);
        expect(usageDelta.usage.cache_read_input_tokens).toBe(900);
    });

    it("should include usage in message_delta on finish", () => {
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        const events = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }));

        const messageDelta = parseStreamEventData(events, 0);
        expect(events.map((event) => event.event)).toEqual(["message_delta", "message_stop"]);
        expect(messageDelta.delta.stop_reason).toBe("tool_use");
        expect(messageDelta.usage.output_tokens).toBe(20);
    });

    it("should normalize input_tokens to non-cached in inline usage on finish", () => {
        const converter2 = new OpenAIToAnthropicConverter();
        converter2.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123", object: "chat.completion.chunk", created: 1677652288, model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));
        const events = converter2.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123", object: "chat.completion.chunk", created: 1677652288, model: "gpt-4",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
                prompt_tokens: 500, completion_tokens: 30, total_tokens: 530,
                prompt_tokens_details: { cached_tokens: 480 },
            },
        }));
        const messageDelta = parseStreamEventData(events, 0);
        expect(messageDelta.usage.input_tokens).toBe(20);
        expect(messageDelta.usage.output_tokens).toBe(30);
        expect(messageDelta.usage.cache_read_input_tokens).toBe(480);
    });
});
