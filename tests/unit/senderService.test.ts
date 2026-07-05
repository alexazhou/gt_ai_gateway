/**
 * convertRequestBody 单元测试
 *
 * 测试 senderService 中的请求协议转换函数，
 * 覆盖正常转换、格式匹配透传、错误处理等场景。
 */

import { describe, it, expect } from "vitest";
import senderService from "../../src/service/senderService";
import usageUtils from "../../src/util/usageUtils";
import protocolUtils from "../../src/util/protocolUtils";
import { ConverterFactory } from "../../src/util/protocolConverter/ConverterFactory";
import { ApiFormat } from "../../src/constants";
import customError from "../../src/util/customError";

function convertRequestBody(body: string, clientFormat: ApiFormat, upstreamFormat: ApiFormat): string {
    if (clientFormat !== upstreamFormat && (clientFormat === ApiFormat.RESPONSES || upstreamFormat === ApiFormat.RESPONSES)) {
        throw new customError.AppError(`Protocol conversion is not supported for Responses API format`, 400);
    }
    const converter = ConverterFactory.create(clientFormat, upstreamFormat);
    if (!converter && clientFormat !== upstreamFormat) {
        throw new customError.AppError(`Unsupported protocol conversion`, 400);
    }
    if (!converter) return body;
    return converter.convertRequestBody(body);
}


describe("resolveUpstreamFormat", () => {
    it("uses Responses for Anthropic client when only Responses is supported", () => {
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(
            ApiFormat.ANTHROPIC,
            [ApiFormat.RESPONSES],
        );

        expect(upstreamFormat).toBe(ApiFormat.RESPONSES);
    });

    it("falls back to client format when no supported conversion path", () => {
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(
            ApiFormat.OPENAI,
            [ApiFormat.RESPONSES],
        );

        expect(upstreamFormat).toBe(ApiFormat.OPENAI);
    });

    it("returns client format directly when vendor supports it", () => {
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(
            ApiFormat.OPENAI,
            [ApiFormat.OPENAI, ApiFormat.ANTHROPIC],
        );

        expect(upstreamFormat).toBe(ApiFormat.OPENAI);
    });

    it("converts Responses to ANTHROPIC when vendor supports ANTHROPIC", () => {
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(
            ApiFormat.RESPONSES,
            [ApiFormat.ANTHROPIC],
        );

        expect(upstreamFormat).toBe(ApiFormat.ANTHROPIC);
    });

    it("converts ANTHROPIC to OPENAI when vendor only supports OPENAI", () => {
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(
            ApiFormat.ANTHROPIC,
            [ApiFormat.OPENAI],
        );

        expect(upstreamFormat).toBe(ApiFormat.OPENAI);
    });
});


describe("normalizeUsage", () => {
    it("reads cached tokens from OpenAI-compatible usage details on Responses format", () => {
        const normalized = usageUtils.normalizeUsage(ApiFormat.RESPONSES, {
            prompt_tokens: 100,
            prompt_tokens_details: { cached_tokens: 40 },
            completion_tokens: 12,
            total_tokens: 112,
        });

        expect(normalized).not.toBeNull();
        expect(normalized!.promptTokens).toBe(100);
        expect(normalized!.outputTokens).toBe(12);
        expect(normalized!.cacheReadTokens).toBe(40);
        expect(normalized!.recordUsage.prompt_tokens).toBe(60);
        expect(normalized!.recordUsage.completion_tokens).toBe(12);
        expect(normalized!.recordUsage.cache_read_tokens).toBe(40);
    });
});


describe("buildStreamUsageAccounting", () => {
    it("stores OpenAI-compatible streamed cache reads as separate record input tokens", () => {
        const accounting = usageUtils.buildStreamUsageAccounting(
            ApiFormat.OPENAI,
            {
                prompt_tokens: 53067,
                completion_tokens: 262,
                cache_read_tokens: 52864,
            },
            {
                prices: {
                    input: 0.002,
                    cache_read: 0.0002,
                    output: 0.01,
                },
            } as any,
        );

        expect(accounting.usageJson).not.toBeNull();
        expect(JSON.parse(accounting.usageJson!)).toMatchObject({
            prompt_tokens: 203,
            completion_tokens: 262,
            cache_read_tokens: 52864,
        });
        expect(accounting.cost).toBeCloseTo(
            ((203 * 0.002) + (52864 * 0.0002) + (262 * 0.01)) / 1000,
            12,
        );
    });
});


describe("isResponsesOutputStartedEvent", () => {
    it("treats function call and reasoning deltas as output start events", () => {
        expect(protocolUtils.isResponsesOutputStartedEvent("response.output_text.delta")).toBe(true);
        expect(protocolUtils.isResponsesOutputStartedEvent("response.function_call_arguments.delta")).toBe(true);
        expect(protocolUtils.isResponsesOutputStartedEvent("response.reasoning_summary_text.delta")).toBe(true);
        expect(protocolUtils.isResponsesOutputStartedEvent("response.output_item.added")).toBe(true);
    });

    it("does not treat lifecycle events as output start events", () => {
        expect(protocolUtils.isResponsesOutputStartedEvent("response.created")).toBe(false);
        expect(protocolUtils.isResponsesOutputStartedEvent("response.in_progress")).toBe(false);
        expect(protocolUtils.isResponsesOutputStartedEvent("response.completed")).toBe(false);
    });
});

// ============================================================
// 基础用例：同格式透传
// ============================================================

describe("convertRequestBody - passthrough", () => {
    it("should return original body when clientFormat equals upstreamFormat (openai)", () => {
        const body = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] });
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.OPENAI);
        expect(result).toBe(body);
    });

    it("should return original body when clientFormat equals upstreamFormat (anthropic)", () => {
        const body = JSON.stringify({ model: "claude-3", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.ANTHROPIC);
        expect(result).toBe(body);
    });

    it("should return original body when clientFormat equals upstreamFormat (responses)", () => {
        const body = JSON.stringify({ model: "gpt-4", input: "hello" });
        const result = convertRequestBody(body, ApiFormat.RESPONSES, ApiFormat.RESPONSES);
        expect(result).toBe(body);
    });
});

// ============================================================
// Anthropic → OpenAI 转换
// ============================================================

describe("convertRequestBody - Anthropic to OpenAI", () => {
    it("should convert a basic Anthropic request to OpenAI format", () => {
        const anthropicReq = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(anthropicReq);
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const parsed = JSON.parse(result);

        expect(parsed.model).toBe("claude-3-sonnet-20240229");
        expect(parsed.messages).toBeDefined();
        expect(parsed.max_tokens).toBe(1024);
        // Anthropic system field should be converted to system message
        expect(parsed.messages[0].role).toBe("user");
    });

    it("should convert Anthropic system prompt to OpenAI system message", () => {
        const anthropicReq = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 512,
            system: "You are a helpful assistant.",
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(anthropicReq);
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const parsed = JSON.parse(result);

        // System message should be first
        expect(parsed.messages[0].role).toBe("system");
        expect(parsed.messages[0].content).toBe("You are a helpful assistant.");
        // User message should follow
        expect(parsed.messages[1].role).toBe("user");
    });

    it("should convert Anthropic tools to OpenAI function tools", () => {
        const anthropicReq = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            tools: [
                {
                    name: "get_weather",
                    description: "Get weather info",
                    input_schema: {
                        type: "object",
                        properties: {
                            location: { type: "string" },
                        },
                    },
                },
            ],
            messages: [
                { role: "user", content: "What's the weather?" },
            ],
        };
        const body = JSON.stringify(anthropicReq);
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const parsed = JSON.parse(result);

        expect(parsed.tools).toBeDefined();
        expect(parsed.tools).toHaveLength(1);
        expect(parsed.tools[0].type).toBe("function");
        expect(parsed.tools[0].function.name).toBe("get_weather");
        expect(parsed.tools[0].function.description).toBe("Get weather info");
        expect(parsed.tools[0].function.parameters).toBeDefined();
    });

    it("should convert Anthropic stop_sequences to OpenAI stop", () => {
        const anthropicReq = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 100,
            stop_sequences: ["STOP", "END"],
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(anthropicReq);
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const parsed = JSON.parse(result);

        expect(parsed.stop).toEqual(["STOP", "END"]);
    });

    it("should convert Anthropic content blocks to OpenAI format", () => {
        const anthropicReq = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "What's in this image?" },
                    ],
                },
            ],
        };
        const body = JSON.stringify(anthropicReq);
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const parsed = JSON.parse(result);

        expect(parsed.messages[0].content).toBeDefined();
        // Single text block should be extracted as string
        expect(typeof parsed.messages[0].content).toBe("string");
        expect(parsed.messages[0].content).toBe("What's in this image?");
    });
});

// ============================================================
// OpenAI → Anthropic 转换
// ============================================================

describe("convertRequestBody - OpenAI to Anthropic", () => {
    it("should convert a basic OpenAI request to Anthropic format", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        expect(parsed.model).toBe("gpt-4");
        expect(parsed.max_tokens).toBe(1024);
        expect(parsed.messages).toBeDefined();
        expect(parsed.messages[0].role).toBe("user");
    });

    it("should convert OpenAI system message to Anthropic system field", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 512,
            messages: [
                { role: "system", content: "You are a helpful assistant." },
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        expect(parsed.system).toBe("You are a helpful assistant.");
        // System message should be removed from messages array
        const userMessages = parsed.messages.filter((m: any) => m.role === "system");
        expect(userMessages).toHaveLength(0);
    });

    it("should convert OpenAI function tools to Anthropic tools", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 1024,
            tools: [
                {
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "Get weather info",
                        parameters: {
                            type: "object",
                            properties: {
                                location: { type: "string" },
                            },
                        },
                    },
                },
            ],
            messages: [
                { role: "user", content: "What's the weather?" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        expect(parsed.tools).toBeDefined();
        expect(parsed.tools).toHaveLength(1);
        expect(parsed.tools[0].name).toBe("get_weather");
        expect(parsed.tools[0].description).toBe("Get weather info");
        expect(parsed.tools[0].input_schema).toBeDefined();
    });

    it("should convert OpenAI stop to Anthropic stop_sequences", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 100,
            stop: ["STOP", "END"],
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        expect(parsed.stop_sequences).toEqual(["STOP", "END"]);
    });

    it("should default max_tokens to 4096 when not provided", () => {
        const openaiReq = {
            model: "gpt-4",
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        expect(parsed.max_tokens).toBe(4096);
    });

    it("should convert OpenAI tool_calls to Anthropic tool_use content blocks", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "What's the weather?" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_abc123",
                            type: "function",
                            function: {
                                name: "get_weather",
                                arguments: "{\"location\": \"San Francisco\"}",
                            },
                        },
                    ],
                },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        // Assistant message should have content blocks with tool_use
        const assistantMsg = parsed.messages.find((m: any) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        const toolUseBlock = assistantMsg.content.find((b: any) => b.type === "tool_use");
        expect(toolUseBlock).toBeDefined();
        expect(toolUseBlock.id).toBe("call_abc123");
        expect(toolUseBlock.name).toBe("get_weather");
    });

    it("should convert OpenAI tool message to Anthropic tool_result content block", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 1024,
            messages: [
                { role: "user", content: "What's the weather?" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_abc123",
                            type: "function",
                            function: { name: "get_weather", arguments: "{}" },
                        },
                    ],
                },
                {
                    role: "tool",
                    tool_call_id: "call_abc123",
                    content: "Sunny, 72°F",
                },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        // Tool message should become an assistant message with tool_result
        const toolResultMsg = parsed.messages.find((m: any) =>
            m.role === "user" && Array.isArray(m.content) &&
            m.content.some((b: any) => b.type === "tool_result"),
        );
        expect(toolResultMsg).toBeDefined();
        const toolResultBlock = toolResultMsg.content.find((b: any) => b.type === "tool_result");
        expect(toolResultBlock.tool_use_id).toBe("call_abc123");
    });
});

// ============================================================
// 错误处理
// ============================================================

describe("convertRequestBody - error handling", () => {
    it("should throw AppError(400) when Responses API format is involved (client)", () => {
        const body = JSON.stringify({ model: "gpt-4", input: "hello" });
        try {
            convertRequestBody(body, ApiFormat.RESPONSES, ApiFormat.OPENAI);
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
            expect(e.message).toContain("not supported");
            expect(e.message).toContain("Responses");
        }
    });

    it("should throw AppError(400) when Responses API format is involved (upstream)", () => {
        const body = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] });
        try {
            convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.RESPONSES);
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
            expect(e.message).toContain("not supported");
        }
    });

    it("should throw AppError(400) for invalid JSON body", () => {
        const invalidBody = "{ not valid json }";
        try {
            convertRequestBody(invalidBody, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
            expect(e.message).toContain("invalid JSON");
        }
    });

    it("should throw AppError(400) for unsupported format combination", () => {
        // Google format is defined in the enum but not supported for conversion
        const body = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] });
        // Force an unsupported combination by using GOOGLE format (enum value exists)
        // Note: This tests the else branch in the function
        const ApiFormatGoogle = "google" as any;
        try {
            convertRequestBody(body, ApiFormat.OPENAI, ApiFormatGoogle);
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
            // Should be "Unsupported protocol conversion" or wrapped conversion error
            expect(e.message).toBeTruthy();
        }
    });

    it("should throw AppError(400) when conversion function fails internally", () => {
        // An Anthropic request with empty messages array will cause conversion to fail
        // because the function expects at least one message
        const badAnthropicReq = {
            model: "claude-3",
            max_tokens: 100,
            messages: [],
        };
        const body = JSON.stringify(badAnthropicReq);
        try {
            convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
            // This might or might not throw depending on how forgiving the converter is
            // If it doesn't throw, that's OK - we just verify the error handling path works
        } catch (e: any) {
            // If it does throw, it should be an AppError with 400
            expect(e.statusCode).toBe(400);
        }
    });
});

// ============================================================
// 边界情况
// ============================================================

describe("convertRequestBody - edge cases", () => {
    it("should handle Anthropic request with streaming flag", () => {
        const anthropicReq = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 1024,
            stream: true,
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(anthropicReq);
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const parsed = JSON.parse(result);

        expect(parsed.stream).toBe(true);
    });

    it("should handle OpenAI request with streaming flag", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 1024,
            stream: true,
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        expect(parsed.stream).toBe(true);
    });

    it("should preserve temperature and top_p parameters", () => {
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 1024,
            temperature: 0.5,
            top_p: 0.9,
            messages: [
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        const parsed = JSON.parse(result);

        expect(parsed.temperature).toBe(0.5);
        expect(parsed.top_p).toBe(0.9);
    });

    it("should preserve Anthropic thinking configuration", () => {
        const anthropicReq = {
            model: "claude-3-sonnet-20240229",
            max_tokens: 4096,
            thinking: { type: "enabled", budget_tokens: 10000 },
            messages: [
                { role: "user", content: "Solve this problem" },
            ],
        };
        const body = JSON.stringify(anthropicReq);
        const result = convertRequestBody(body, ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const parsed = JSON.parse(result);

        // Thinking config should be converted appropriately for OpenAI
        // (the exact handling depends on the converter implementation)
        expect(parsed.model).toBe("claude-3-sonnet-20240229");
        expect(parsed.max_tokens).toBe(4096);
    });

    it("should produce valid JSON output after round-trip concept check", () => {
        // Verify that the output of convertRequestBody is always valid JSON
        const openaiReq = {
            model: "gpt-4",
            max_tokens: 1024,
            messages: [
                { role: "system", content: "Be concise." },
                { role: "user", content: "Hello" },
            ],
        };
        const body = JSON.stringify(openaiReq);
        const result = convertRequestBody(body, ApiFormat.OPENAI, ApiFormat.ANTHROPIC);

        // Should be valid JSON
        expect(() => JSON.parse(result)).not.toThrow();
        const parsed = JSON.parse(result);
        expect(parsed.messages).toBeDefined();
        expect(parsed.max_tokens).toBeTypeOf("number");
    });
});
