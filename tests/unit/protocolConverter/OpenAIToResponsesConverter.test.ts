import { describe, it, expect } from "vitest";
import { OpenAIToResponsesConverter } from "../../../src/util/protocolConverter/OpenAIToResponsesConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ApiFormat } from "../../../src/constants";
import openaiChatAccumulator from "../../../src/util/accumulator/openaiChatAccumulator";
import type {
    OpenAIRequest,
    OpenAIResponse,
    OpenAIChunk,
} from "../../../src/util/protocolConverter/protocolTypes";
import type {
    ResponsesNonStreamResponse,
} from "../../../src/util/protocolConverter/responsesTypes";

describe("OpenAIToResponsesConverter", () => {
    const converter = new OpenAIToResponsesConverter("gpt-4");

    // ─── convertRequest 测试 ───

    describe("convertRequest", () => {
        it("should convert simple text request", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [
                    { role: "user", content: "Hello, world!" },
                ],
            };
            const result = converter.convertRequest(req);
            expect(result.model).toBe("gpt-4");
            expect(result.input).toHaveLength(1);
            expect(result.input[0]).toEqual({
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Hello, world!" }],
            });
        });

        it("should convert system message to instructions", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: "Hi" },
                ],
            };
            const result = converter.convertRequest(req);
            expect(result.instructions).toBe("You are a helpful assistant.");
            expect(result.input).toHaveLength(1);
            expect(result.input[0]).toEqual({
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Hi" }],
            });
        });

        it("should convert multiple system messages", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [
                    { role: "system", content: "Be helpful." },
                    { role: "system", content: "Be concise." },
                    { role: "user", content: "Hi" },
                ],
            };
            const result = converter.convertRequest(req);
            expect(result.instructions).toBe("Be helpful.\nBe concise.");
        });

        it("should convert assistant message", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [
                    { role: "user", content: "Hello" },
                    { role: "assistant", content: "Hi there!" },
                    { role: "user", content: "How are you?" },
                ],
            };
            const result = converter.convertRequest(req);
            expect(result.input).toHaveLength(3);
            expect(result.input[0]).toEqual({
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Hello" }],
            });
            expect(result.input[1]).toEqual({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hi there!" }],
            });
            expect(result.input[2]).toEqual({
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "How are you?" }],
            });
        });

        it("should convert tool_calls to function_call", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [{
                            id: "call_123",
                            type: "function",
                            function: {
                                name: "get_weather",
                                arguments: '{"city":"Beijing"}',
                            },
                        }],
                    },
                ],
            };
            const result = converter.convertRequest(req);
            expect(result.input).toHaveLength(1);
            expect(result.input[0]).toEqual({
                type: "function_call",
                call_id: "call_123",
                name: "get_weather",
                arguments: '{"city":"Beijing"}',
            });
        });

        it("should convert tool message to function_call_output", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [
                    {
                        role: "tool",
                        tool_call_id: "call_123",
                        content: '{"temp":25}',
                    },
                ],
            };
            const result = converter.convertRequest(req);
            expect(result.input).toHaveLength(1);
            expect(result.input[0]).toEqual({
                type: "function_call_output",
                call_id: "call_123",
                output: '{"temp":25}',
            });
        });

        it("should convert tools", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [{ role: "user", content: "Hi" }],
                tools: [{
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "Get weather info",
                        parameters: {
                            type: "object",
                            properties: {
                                city: { type: "string" },
                            },
                        },
                    },
                }],
            };
            const result = converter.convertRequest(req);
            expect(result.tools).toHaveLength(1);
            expect(result.tools![0]).toEqual({
                type: "function",
                name: "get_weather",
                description: "Get weather info",
                parameters: {
                    type: "object",
                    properties: {
                        city: { type: "string" },
                    },
                },
            });
        });

        it("should convert tool_choice", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [{ role: "user", content: "Hi" }],
                tool_choice: "auto",
            };
            const result = converter.convertRequest(req);
            expect(result.tool_choice).toBe("auto");

            const req2: OpenAIRequest = {
                model: "gpt-4",
                messages: [{ role: "user", content: "Hi" }],
                tool_choice: "required",
            };
            const result2 = converter.convertRequest(req2);
            expect(result2.tool_choice).toBe("required");

            const req3: OpenAIRequest = {
                model: "gpt-4",
                messages: [{ role: "user", content: "Hi" }],
                tool_choice: {
                    type: "function",
                    function: { name: "get_weather" },
                },
            };
            const result3 = converter.convertRequest(req3);
            expect(result3.tool_choice).toEqual({
                type: "function",
                name: "get_weather",
            });
        });

        it("should convert max_tokens to max_output_tokens", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [{ role: "user", content: "Hi" }],
                max_tokens: 1000,
            };
            const result = converter.convertRequest(req);
            expect(result.max_output_tokens).toBe(1000);
        });

        it("should pass through temperature and top_p", () => {
            const req: OpenAIRequest = {
                model: "gpt-4",
                messages: [{ role: "user", content: "Hi" }],
                temperature: 0.7,
                top_p: 0.9,
            };
            const result = converter.convertRequest(req);
            expect(result.temperature).toBe(0.7);
            expect(result.top_p).toBe(0.9);
        });
    });

    // ─── convertResponse 测试 ───

    describe("convertResponse", () => {
        it("should convert simple text response", () => {
            const res: ResponsesNonStreamResponse = {
                id: "resp_123",
                object: "response",
                created_at: 1234567890,
                status: "completed",
                model: "gpt-4",
                output: [{
                    type: "message",
                    id: "msg_123",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Hello!" }],
                }],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
            };
            const result = converter.convertResponse(res);
            expect(result.id).toBe("chatcmpl-123");
            expect(result.object).toBe("chat.completion");
            expect(result.choices).toHaveLength(1);
            expect(result.choices[0].message.content).toBe("Hello!");
            expect(result.choices[0].finish_reason).toBe("stop");
        });

        it("should convert tool_calls response", () => {
            const res: ResponsesNonStreamResponse = {
                id: "resp_123",
                object: "response",
                created_at: 1234567890,
                status: "completed",
                model: "gpt-4",
                output: [{
                    type: "function_call",
                    id: "fc_123",
                    call_id: "call_123",
                    name: "get_weather",
                    arguments: '{"city":"Beijing"}',
                    status: "completed",
                }],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
            };
            const result = converter.convertResponse(res);
            expect(result.choices[0].finish_reason).toBe("tool_calls");
            expect(result.choices[0].message.tool_calls).toHaveLength(1);
            expect(result.choices[0].message.tool_calls![0]).toEqual({
                id: "call_123",
                type: "function",
                function: {
                    name: "get_weather",
                    arguments: '{"city":"Beijing"}',
                },
            });
        });

        it("should convert reasoning response", () => {
            const res: ResponsesNonStreamResponse = {
                id: "resp_123",
                object: "response",
                created_at: 1234567890,
                status: "completed",
                model: "gpt-4",
                output: [
                    {
                        type: "reasoning",
                        id: "rs_123",
                        summary: [{ type: "summary_text", text: "Let me think..." }],
                    },
                    {
                        type: "message",
                        id: "msg_123",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: "The answer is 42." }],
                    },
                ],
                usage: {
                    input_tokens: 10,
                    output_tokens: 20,
                    total_tokens: 30,
                },
            };
            const result = converter.convertResponse(res);
            expect(result.choices[0].message.reasoning_content).toBe("Let me think...");
            expect(result.choices[0].message.content).toBe("The answer is 42.");
        });

        it("should map usage correctly", () => {
            const res: ResponsesNonStreamResponse = {
                id: "resp_123",
                object: "response",
                created_at: 1234567890,
                status: "completed",
                model: "gpt-4",
                output: [{
                    type: "message",
                    id: "msg_123",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Hi" }],
                }],
                usage: {
                    input_tokens: 100,
                    output_tokens: 50,
                    total_tokens: 150,
                    input_tokens_details: { cached_tokens: 20 },
                    output_tokens_details: { reasoning_tokens: 10 },
                },
            };
            const result = converter.convertResponse(res);
            expect(result.usage).toEqual({
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                prompt_tokens_details: { cached_tokens: 20 },
                completion_tokens_details: { reasoning_tokens: 10 },
            });
        });

        it("should use requestId when provided", () => {
            const res: ResponsesNonStreamResponse = {
                id: "resp_123",
                object: "response",
                created_at: 1234567890,
                status: "completed",
                model: "gpt-4",
                output: [{
                    type: "message",
                    id: "msg_123",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Hi" }],
                }],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
            };
            const result = converter.convertResponse(res, "chatcmpl-custom");
            expect(result.id).toBe("chatcmpl-custom");
        });
    });

    // ─── 流式事件转换 ───

    describe("convertStreamEvent - 上游失败", () => {
        it("should hand response.failed to the client and to the accumulator", () => {
            const converter = new OpenAIToResponsesConverter("gpt-4");

            // Responses 的模型级失败形态：event: response.failed + response.status = failed
            const events = converter.convertStreamEvent(
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

            // ① 客户端必须看到失败详情：HTTP 状态已是 200，SSE 体是唯一的错误通道，
            //    否则客户端只能看到一条被截断的流
            const errorEvent = events.find((e) => e.event === "error");
            expect(errorEvent).toBeDefined();
            expect(JSON.parse(errorEvent!.data).error.message).toBe("upstream exploded");

            // ② 记账层也必须看得到：runSSELoop 把【转换后】的事件同时喂给客户端格式的累加器，
            //    转换器吞掉错误会让请求被记成成功并计费
            const accumulator = new openaiChatAccumulator.OpenAIChatAccumulator();
            for (const event of events) {
                accumulator.addEvent(event);
            }
            expect(accumulator.isErrored()).toBe(true);
        });
    });

    // ─── ConverterFactory 测试 ───

    describe("ConverterFactory", () => {
        it("should create OpenAIToResponsesConverter for OPENAI → RESPONSES", () => {
            const converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.RESPONSES, "gpt-4");
            expect(converter).toBeInstanceOf(OpenAIToResponsesConverter);
        });

        it("should create ResponsesToOpenAIConverter for RESPONSES → OPENAI", () => {
            const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.OPENAI, "gpt-4");
            expect(converter).not.toBeNull();
        });
    });
});
