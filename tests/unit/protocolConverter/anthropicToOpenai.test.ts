/**
 * Anthropic -> OpenAI 协议转换单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AnthropicToOpenAIConverter } from "../../../src/util/protocolConverter/AnthropicToOpenAIConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ReasoningEffort } from "../../../src/util/protocolConverter/thinkingConfig";
import { ApiFormat } from "../../../src/constants";
import type { AnthropicRequest, OpenAIRequest, OpenAIResponse, ProtocolStreamEvent } from "../../../src/util/protocolConverter/protocolTypes";

function parseStreamEventData(events: ProtocolStreamEvent[], index: number = 0): any {
    return JSON.parse(events[index].data);
}

describe("AnthropicToOpenAIConverter - convertRequest", () => {
    let converter: AnthropicToOpenAIConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI) as AnthropicToOpenAIConverter;
    });

    it("should convert a simple text message", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "Hello, how are you?" },
            ],
        };

        const result = converter.convertRequest(anthropicReq) as OpenAIRequest;

        expect(result.model).toBe("claude-3-sonnet-20240229");
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe("user");
        expect(result.messages[0].content).toBe("Hello, how are you?");
        expect(result.max_tokens).toBe(1024);
    });

    it("should convert system prompt from string to system message", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            system: "You are a helpful assistant.",
            messages: [
                { role: "user", content: "Hello" },
            ],
        };

        const result = converter.convertRequest(anthropicReq);

        expect(result.messages[0]).toEqual({
            role: "system",
            content: "You are a helpful assistant.",
        });
        expect(result.messages[1].role).toBe("user");
    });

    it("should convert system prompt from array to system message", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            system: [
                { type: "text", text: "You are a helpful assistant." },
                { type: "text", text: "Be concise." },
            ],
            messages: [
                { role: "user", content: "Hello" },
            ],
        };

        const result = converter.convertRequest(anthropicReq);

        expect(result.messages[0].role).toBe("system");
        expect(result.messages[0].content).toBe("You are a helpful assistant.\n\nBe concise.");
    });

    it("should convert Anthropic tools to OpenAI function calling format", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "What's the weather?" }],
            tools: [
                {
                    name: "get_weather",
                    description: "Get weather for a location",
                    input_schema: {
                        type: "object",
                        properties: {
                            location: { type: "string" },
                        },
                        required: ["location"],
                    },
                },
            ],
        };

        const result = converter.convertRequest(anthropicReq);

        expect(result.tools).toHaveLength(1);
        expect(result.tools![0]).toEqual({
            type: "function",
            function: {
                name: "get_weather",
                description: "Get weather for a location",
                parameters: {
                    type: "object",
                    properties: { location: { type: "string" } },
                    required: ["location"],
                },
            },
        });
    });

    it("should convert Anthropic tool_choice to OpenAI format", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            tool_choice: { type: "any" },
        };

        const result = converter.convertRequest(anthropicReq);
        expect(result.tool_choice).toBe("required");
    });

    it("should convert named Anthropic tool_choice to OpenAI function choice", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            tool_choice: { type: "tool", name: "get_weather" },
        };

        const result = converter.convertRequest(anthropicReq);
        expect(result.tool_choice).toEqual({
            type: "function",
            function: { name: "get_weather" },
        });
    });

    it("should convert Anthropic adaptive thinking + output_config to OpenAI reasoning_effort", () => {
        const baseReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
        };

        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "disabled" },
        }).reasoning_effort).toBe(ReasoningEffort.NONE);
        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.MINIMAL },
        }).reasoning_effort).toBe(ReasoningEffort.MINIMAL);
        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.LOW },
        }).reasoning_effort).toBe(ReasoningEffort.LOW);
        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.MEDIUM },
        }).reasoning_effort).toBe(ReasoningEffort.MEDIUM);
        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.HIGH },
        }).reasoning_effort).toBe(ReasoningEffort.HIGH);
        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "adaptive" },
            output_config: { effort: ReasoningEffort.XHIGH },
        }).reasoning_effort).toBe(ReasoningEffort.XHIGH);
    });

    it("should fall back to HIGH effort when adaptive thinking has no output_config", () => {
        const baseReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
        };

        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "adaptive" },
        }).reasoning_effort).toBe(ReasoningEffort.HIGH);
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
        }).reasoning_effort).toBe(ReasoningEffort.HIGH);
        expect(converter.convertRequest({
            ...baseReq,
            thinking: { type: "enabled", budget_tokens: 16000 },
        }).reasoning_effort).toBe(ReasoningEffort.XHIGH);
    });

    it("should extract thinking blocks to reasoning_content", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "reasoning" },
                        { type: "text", text: "answer" },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(anthropicReq);
        expect(result.messages[0].content).toBe("answer");
        expect((result.messages[0] as any).reasoning_content).toBe("reasoning");
    });

    it("should assign empty string to reasoning_content if thinking block is empty", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "" },
                        { type: "text", text: "answer" },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(anthropicReq);
        expect(result.messages[0].content).toBe("answer");
        expect((result.messages[0] as any).reasoning_content).toBe("");
    });

    it("should convert assistant message with tool_use to OpenAI tool_calls", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "What's the weather?" },
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Let me check the weather." },
                        { type: "tool_use", id: "toolu_123", name: "get_weather", input: { location: "Tokyo" } },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(anthropicReq);

        const assistantMsg = result.messages.find((m: any) => m.role === "assistant")!;
        expect(assistantMsg.content).toBe("Let me check the weather.");
        expect(assistantMsg.tool_calls).toHaveLength(1);
        expect(assistantMsg.tool_calls![0].id).toBe("toolu_123");
        expect(assistantMsg.tool_calls![0].function.name).toBe("get_weather");
        expect(assistantMsg.tool_calls![0].function.arguments).toBe('{"location":"Tokyo"}');
    });

    it("should convert tool_result content blocks to tool messages", () => {
        const anthropicReq: AnthropicRequest = {
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

        const result = converter.convertRequest(anthropicReq);

        const toolMsg = result.messages.find((m: any) => m.role === "tool")!;
        expect(toolMsg.content).toBe("Sunny, 25°C");
        expect(toolMsg.tool_call_id).toBe("toolu_123");
    });

    it("should place tool_result before normal user text when converting mixed content blocks", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "I will run a check." },
                        {
                            type: "tool_use",
                            id: "call_check",
                            name: "Agent",
                            input: { description: "Run TypeScript check" },
                        },
                    ],
                },
                {
                    role: "user",
                    content: [
                        { type: "tool_result", tool_use_id: "call_check", content: "The tool use was rejected." },
                        { type: "text", text: "[Request interrupted by user for tool use]\n" },
                        { type: "text", text: "Run tests directly\n" },
                        { type: "text", text: "Continue" },
                    ],
                },
            ],
        };

        const result = converter.convertRequest(anthropicReq);

        expect(result.messages).toHaveLength(3);
        expect(result.messages[0]).toMatchObject({
            role: "assistant",
            content: "I will run a check.",
            tool_calls: [
                {
                    id: "call_check",
                    type: "function",
                    function: {
                        name: "Agent",
                        arguments: '{"description":"Run TypeScript check"}',
                    },
                },
            ],
        });
        expect(result.messages[1]).toEqual({
            role: "tool",
            tool_call_id: "call_check",
            content: "The tool use was rejected.",
        });
        expect(result.messages[2]).toEqual({
            role: "user",
            content: "[Request interrupted by user for tool use]\n\nRun tests directly\n\nContinue",
        });
    });

    it("should convert stop_sequences to stop", () => {
        const anthropicReq: AnthropicRequest = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            stop_sequences: ["END", "STOP"],
        };

        const result = converter.convertRequest(anthropicReq);
        expect(result.stop).toEqual(["END", "STOP"]);
    });
});

// ============================================================
// 非流式响应转换：OpenAI upstream → Anthropic client
// ============================================================

describe("AnthropicToOpenAIConverter - convertResponse", () => {
    let converter: AnthropicToOpenAIConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI) as AnthropicToOpenAIConverter;
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
// 流式转换：OpenAI upstream → Anthropic client
// ============================================================

describe("AnthropicToOpenAIConverter - convertStreamEvent", () => {
    let converter: AnthropicToOpenAIConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4") as AnthropicToOpenAIConverter;
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

    it("should only create one content_block_start when upstream sends same tool_call id with null name in subsequent chunks", () => {
        // This simulates the issue where glm-5.2 sends tool_call with name in first chunk
        // but null name in subsequent chunks with the same id
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        // First chunk: has id and name
        const startEvents1 = converter.convertStreamEvent(JSON.stringify({
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
                                id: "chatcmpl-tool-xxx",
                                type: "function",
                                function: { name: "Bash", arguments: "" },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        }));

        // Should have content_block_start with name "Bash"
        expect(startEvents1.map((e) => e.event)).toEqual(["content_block_start"]);
        const startData1 = parseStreamEventData(startEvents1, 0);
        expect(startData1.content_block.type).toBe("tool_use");
        expect(startData1.content_block.name).toBe("Bash");
        expect(startData1.content_block.id).toBe("chatcmpl-tool-xxx");

        // Second chunk: same id, but name is null (simulating glm-5.2 behavior)
        const startEvents2 = converter.convertStreamEvent(JSON.stringify({
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
                                id: "chatcmpl-tool-xxx",
                                type: "function",
                                function: { name: null, arguments: '{"command": "ls"}' },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        }));

        // Should NOT create another content_block_start, only input_json_delta
        expect(startEvents2.map((e) => e.event)).toEqual(["content_block_delta"]);
        const deltaData2 = parseStreamEventData(startEvents2, 0);
        expect(deltaData2.delta.type).toBe("input_json_delta");
        expect(deltaData2.delta.partial_json).toBe('{"command": "ls"}');

        // Third chunk: same id, name is still null
        const startEvents3 = converter.convertStreamEvent(JSON.stringify({
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
                                id: "chatcmpl-tool-xxx",
                                type: "function",
                                function: { name: null, arguments: " doc" },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        }));

        // Should still NOT create another content_block_start
        expect(startEvents3.map((e) => e.event)).toEqual(["content_block_delta"]);
        const deltaData3 = parseStreamEventData(startEvents3, 0);
        expect(deltaData3.delta.type).toBe("input_json_delta");
        expect(deltaData3.delta.partial_json).toBe(" doc");
    });

    it("should convert finish_reason to proper stop events", () => {
        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
        }));

        const finishEvents = converter.convertStreamEvent(JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion.chunk",
            created: 1677652288,
            model: "gpt-4",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }));

        expect(finishEvents.map((event) => event.event)).toEqual(["content_block_stop"]);

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
        const converter2 = new AnthropicToOpenAIConverter();
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
        const converter2 = new AnthropicToOpenAIConverter();
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

    it("should pass through error stream events", () => {
        const errorData = {
            type: "error",
            error: { type: "rate_limit_error", message: "rate limited" },
        };

        const events = converter.convertStreamEvent(JSON.stringify(errorData));

        expect(events).toEqual([{ event: "error", data: JSON.stringify(errorData) }]);
    });
});
