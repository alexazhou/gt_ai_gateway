import { describe, it, expect } from "vitest";
import { ApiFormat } from "../../../src/constants";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ResponsesAccumulator } from "../../../src/util/accumulator/responsesAccumulator";
import { UpstreamUsageCollector, normalizeUsage, calculateCost } from "../../../src/util/protocolUtil/usageUtil";
import type { SgModel } from "../../../src/model/sgModel";
import type { AnthropicResponse } from "../../../src/util/protocol/anthropicTypes";
import type { OpenAIChunk, OpenAIRequest, OpenAIResponse } from "../../../src/util/protocol/openaiTypes";
import type { ResponsesNonStreamResponse, ResponsesRequest } from "../../../src/util/protocol/responsesTypes";

describe("Protocol Conversion Fixes (PC-001 ~ PC-011)", () => {
    describe("PC-001 & PC-011: Cache usage accounting and derived inputs", () => {
        it("Chat -> Responses streaming should not double-count cached tokens in total_tokens", () => {
            const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.OPENAI, "gpt-4o")!;
            const events = [
                ...converter.convertStreamEvent(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [],
                    usage: {
                        prompt_tokens: 100,
                        completion_tokens: 5,
                        total_tokens: 105,
                        prompt_tokens_details: { cached_tokens: 90 },
                    },
                })),
                ...converter.convertStreamEvent("[DONE]"),
            ];

            const completed = events.map((e) => JSON.parse(e.data)).find((d) => d.type === "response.completed");
            expect(completed.response.usage).toEqual({
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 90 },
                output_tokens: 5,
                total_tokens: 105,
            });
        });

        it("Anthropic -> Responses streaming & non-streaming should include cached_tokens in input_tokens", () => {
            const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const nonStream = converter.convertResponse({
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-3-7-sonnet",
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
            }) as ResponsesNonStreamResponse;
            expect(nonStream.usage).toEqual({
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 90 },
                output_tokens: 5,
                total_tokens: 105,
            });

            const streamEvents = [
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "message_start",
                    message: {
                        id: "msg_1",
                        model: "claude-3-7-sonnet",
                        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 },
                    },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 5 },
                })),
                ...converter.convertStreamEvent(JSON.stringify({ type: "message_stop" })),
            ];
            const completed = streamEvents.map((e) => JSON.parse(e.data)).find((d) => d.type === "response.completed");
            expect(completed.response.usage).toEqual({
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 90 },
                output_tokens: 5,
                total_tokens: 105,
            });

            // Verify billing chain with ResponsesAccumulator
            const acc = new ResponsesAccumulator();
            for (const ev of streamEvents) acc.addEvent(ev);
            const norm = normalizeUsage(ApiFormat.OPENAI, acc.getUsage() as Record<string, unknown>)!;
            const model = { prices: { input: 10, cache_read: 1, output: 20 } } as unknown as SgModel;
            expect(calculateCost(model, norm.promptTokens, norm.outputTokens, norm.cacheReadTokens)).toBe(0.00029);
        });

        it("Anthropic -> Chat streaming & non-streaming should preserve message_start cached tokens", () => {
            const converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const nonStream = converter.convertResponse({
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-3-7-sonnet",
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
            }) as OpenAIResponse;
            expect(nonStream.usage).toEqual({
                prompt_tokens: 100,
                completion_tokens: 5,
                total_tokens: 105,
                prompt_tokens_details: { cached_tokens: 90 },
            });

            const events = [
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "message_start",
                    message: {
                        id: "msg_1",
                        model: "claude-3-7-sonnet",
                        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 },
                    },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 5 },
                })),
            ];
            const deltaChunk = JSON.parse(events[1].data) as OpenAIChunk;
            expect(deltaChunk.usage).toEqual({
                prompt_tokens: 100,
                completion_tokens: 5,
                total_tokens: 105,
                prompt_tokens_details: { cached_tokens: 90 },
            });
        });

        it("Chat -> Anthropic segmented streaming & non-streaming (PC-011) should recompute non-cached input", () => {
            const converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4o")!;

            // PC-011 non-streaming
            const nonStream = converter.convertResponse({
                id: "chatcmpl-1",
                object: "chat.completion",
                created: 1,
                model: "gpt-4o",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 5,
                    total_tokens: 105,
                    prompt_tokens_details: { cached_tokens: 90 },
                },
            }) as AnthropicResponse;
            expect(nonStream.usage).toEqual({
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 90,
            });

            // Explicit 0 vs missing cached_tokens
            const explicitZero = converter.convertResponse({
                id: "chatcmpl-2",
                object: "chat.completion",
                created: 1,
                model: "gpt-4o",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 5,
                    total_tokens: 105,
                    prompt_tokens_details: { cached_tokens: 0 },
                },
            }) as AnthropicResponse;
            expect(explicitZero.usage).toEqual({
                input_tokens: 100,
                output_tokens: 5,
                cache_read_input_tokens: 0,
            });

            // Segmented streaming: prompt_tokens arrives before cached_tokens
            const streamEvents = [
                ...converter.convertStreamEvent(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 100, completion_tokens: 5 },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [],
                    usage: { prompt_tokens_details: { cached_tokens: 90 } },
                })),
                ...converter.convertStreamEvent("[DONE]"),
            ];
            const msgDelta = streamEvents.find((e) => e.event === "message_delta");
            expect(JSON.parse(msgDelta!.data).usage).toEqual({
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 90,
            });
        });

        it("UpstreamUsageCollector should collect raw upstream usage across segmented chunks", () => {
            const collector = new UpstreamUsageCollector(ApiFormat.OPENAI);
            collector.addEvent(JSON.stringify({
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
            collector.addEvent(JSON.stringify({
                choices: [],
                usage: { prompt_tokens_details: { cached_tokens: 90 } },
            }));
            collector.addEvent("[DONE]");

            const norm = normalizeUsage(ApiFormat.OPENAI, collector.getUsage())!;
            expect(norm.promptTokens).toBe(100);
            expect(norm.cacheReadTokens).toBe(90);
            expect(norm.outputTokens).toBe(5);
        });
    });

    describe("PC-002: Termination status, incomplete handling, and trailing usage", () => {
        it("Responses -> Chat should map response.incomplete to length/content_filter and [DONE]", () => {
            const converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.RESPONSES, "gpt-4o")!;
            const events = [
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "response.created",
                    response: { id: "resp_1", model: "gpt-4o", status: "in_progress", output: [] },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "response.output_text.delta",
                    delta: "partial",
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "response.incomplete",
                    response: {
                        id: "resp_1",
                        status: "incomplete",
                        incomplete_details: { reason: "max_output_tokens" },
                        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                    },
                })),
            ];
            const finishChunk = JSON.parse(events[2].data) as OpenAIChunk;
            expect(finishChunk.choices[0].finish_reason).toBe("length");
            expect(events[events.length - 1].data).toBe("[DONE]");
        });

        it("Chat -> Responses should not prematurely complete on mid-stream usage and should map length to response.incomplete", () => {
            const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.OPENAI, "gpt-4o")!;
            const mid = converter.convertStreamEvent(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "gpt-4o",
                choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }));
            expect(mid.some((e) => JSON.parse(e.data).type === "response.completed")).toBe(false);

            const more = converter.convertStreamEvent(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "gpt-4o",
                choices: [{ index: 0, delta: { content: " there" }, finish_reason: "length" }],
            }));
            // Should NOT emit another response.created
            expect(more.some((e) => JSON.parse(e.data).type === "response.created")).toBe(false);

            const end = converter.onUpstreamEnd();
            const incompleteEv = end.map((e) => JSON.parse(e.data)).find((d) => d.type === "response.incomplete");
            expect(incompleteEv).toBeDefined();
            expect(incompleteEv.response.status).toBe("incomplete");
            expect(incompleteEv.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
            // Idempotent on second call
            expect(converter.onUpstreamEnd()).toEqual([]);
        });

        it("ResponsesAccumulator should mark response.incomplete as completed stream with incomplete status", () => {
            const acc = new ResponsesAccumulator();
            acc.addEvent({
                data: JSON.stringify({
                    type: "response.incomplete",
                    response: {
                        id: "resp_1",
                        status: "incomplete",
                        incomplete_details: { reason: "max_output_tokens" },
                        output: [{ type: "message", id: "msg_1", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "cut" }] }],
                        usage: { input_tokens: 100, output_tokens: 5 },
                    },
                }),
            });
            expect(acc.isCompleted()).toBe(true);
            expect(acc.getResponse().status).toBe("incomplete");
            expect(acc.getResponse().incomplete_details).toEqual({ reason: "max_output_tokens" });
            expect(acc.getUsage()).toEqual({ prompt_tokens: 100, completion_tokens: 5, cache_read_tokens: null });
        });

        it("Anthropic <-> Responses should preserve max_tokens <-> incomplete in stream and non-stream", () => {
            const r2a = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const nonStreamResp = r2a.convertResponse({
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-3-7-sonnet",
                content: [{ type: "text", text: "cut" }],
                stop_reason: "max_tokens",
                usage: { input_tokens: 10, output_tokens: 5 },
            }) as ResponsesNonStreamResponse;
            expect(nonStreamResp.status).toBe("incomplete");
            expect(nonStreamResp.incomplete_details).toEqual({ reason: "max_output_tokens" });

            const a2r = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES, "gpt-4o")!;
            const nonStreamAnthropic = a2r.convertResponse({
                id: "resp_1",
                object: "response",
                created_at: 1,
                model: "gpt-4o",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "cut" }] }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }) as AnthropicResponse;
            expect(nonStreamAnthropic.stop_reason).toBe("max_tokens");
        });
    });

    describe("PC-003, PC-006, PC-010: Ordered output items, accumulator state, and ID/model consistency", () => {
        it("PC-003: Responses -> Anthropic interleaved tool_calls should route deltas to their own block indices", () => {
            const converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES, "gpt-4o")!;
            const events = [
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "toolA" },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "response.output_item.added",
                    output_index: 1,
                    item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "toolB" },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "response.function_call_arguments.delta",
                    output_index: 0,
                    item_id: "fc_a",
                    delta: "{\"a\":1}",
                })),
            ];
            const deltaEv = events.find((e) => e.event === "content_block_delta");
            expect(JSON.parse(deltaEv!.data).index).toBe(0);
        });

        it("PC-003 & PC-006: Anthropic -> Responses should keep output_index consistent and include reasoning in completed output", () => {
            const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const events = [
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "message_start",
                    message: { id: "msg_1", model: "claude-3-7-sonnet", usage: { input_tokens: 10, output_tokens: 0 } },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "thinking", thinking: "" },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "thinking_delta", thinking: "hmm" },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "signature_delta", signature: "sig_real" },
                })),
                ...converter.convertStreamEvent(JSON.stringify({ type: "content_block_stop", index: 0 })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "content_block_start",
                    index: 1,
                    content_block: { type: "text", text: "" },
                })),
                ...converter.convertStreamEvent(JSON.stringify({
                    type: "content_block_delta",
                    index: 1,
                    delta: { type: "text_delta", text: "answer" },
                })),
                ...converter.convertStreamEvent(JSON.stringify({ type: "content_block_stop", index: 1 })),
                ...converter.convertStreamEvent(JSON.stringify({ type: "message_stop" })),
            ];

            const parsed = events.map((e) => JSON.parse(e.data));
            const textDelta = parsed.find((d) => d.type === "response.output_text.delta");
            const textDone = parsed.find((d) => d.type === "response.output_text.done");
            expect(textDelta.output_index).toBe(1);
            expect(textDone.output_index).toBe(1);

            const completed = parsed.find((d) => d.type === "response.completed");
            expect(completed.response.output).toHaveLength(2);
            expect(completed.response.output[0].type).toBe("reasoning");
            expect(completed.response.output[0].summary).toEqual([{ type: "summary_text", text: "hmm" }]);
            expect(completed.response.output[0].encrypted_content).toMatch(/^gw_sig_v1\./);
            expect(completed.response.output[1].type).toBe("message");
        });

        it("PC-003: Chat -> Responses mixed reasoning + content + tool_calls should have distinct output_index", () => {
            const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.OPENAI, "gpt-4o")!;
            const events = [
                ...converter.convertStreamEvent(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            reasoning_content: "think",
                            content: "say",
                            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "fn", arguments: "{}" } }],
                        },
                        finish_reason: "stop",
                    }],
                })),
                ...converter.convertStreamEvent("[DONE]"),
            ];
            const added = events.map((e) => JSON.parse(e.data)).filter((d) => d.type === "response.output_item.added");
            expect(added.map((a) => [a.item.type, a.output_index])).toEqual([
                ["reasoning", 0],
                ["message", 1],
                ["function_call", 2],
            ]);
        });

        it("PC-006: ResponsesAccumulator should accumulate reasoning and function_call fields and guard getText()", () => {
            const acc = new ResponsesAccumulator();
            acc.addEvent({
                data: JSON.stringify({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { type: "reasoning", id: "rs_1" },
                }),
            });
            acc.addEvent({
                data: JSON.stringify({
                    type: "response.reasoning_summary_text.delta",
                    output_index: 0,
                    summary_index: 0,
                    delta: "step 1",
                }),
            });
            acc.addEvent({
                data: JSON.stringify({
                    type: "response.output_item.done",
                    output_index: 1,
                    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "test", arguments: "{\"a\":1}" },
                }),
            });

            expect(acc.getText()).toBe("");
            const resp = acc.getResponse();
            expect(resp.output[0].summary).toEqual([{ type: "summary_text", text: "step 1" }]);
            expect(resp.output[1]).toMatchObject({
                id: "fc_1",
                type: "function_call",
                call_id: "call_1",
                name: "test",
                arguments: "{\"a\":1}",
            });
        });

        it("PC-010: Responses -> Chat should persist upstream id/model across chunks & Anthropic -> Responses should assign unique item IDs", () => {
            const r2o = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.RESPONSES, "requested_model")!;
            const c1 = JSON.parse(r2o.convertStreamEvent(JSON.stringify({
                type: "response.created",
                response: { id: "resp_upstream", model: "actual_model" },
            }))[0].data);
            const c2 = JSON.parse(r2o.convertStreamEvent(JSON.stringify({
                type: "response.output_text.delta",
                delta: "hi",
            }))[0].data);
            expect(c1.id).toBe("chatcmpl-upstream");
            expect(c1.model).toBe("actual_model");
            expect(c2.id).toBe("chatcmpl-upstream");
            expect(c2.model).toBe("actual_model");

            const r2a = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const resp = r2a.convertResponse({
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-3-7-sonnet",
                content: [
                    { type: "thinking", thinking: "t1", signature: "s1" },
                    { type: "thinking", thinking: "t2", signature: "s2" },
                    { type: "text", text: "a" },
                    { type: "text", text: "b" },
                ],
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
            }) as ResponsesNonStreamResponse;
            const ids = resp.output.map((o) => o.id);
            expect(new Set(ids).size).toBe(4);
        });
    });

    describe("PC-004, PC-005, PC-007, PC-008: Tool history, multi-part text, request constraints", () => {
        it("PC-004: Responses -> Anthropic should preserve multi-turn tool call history", () => {
            const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const req: ResponsesRequest = {
                model: "claude-3-7-sonnet",
                input: [
                    { type: "function_call", call_id: "call_1", name: "t1", arguments: "{}" },
                    { type: "function_call_output", call_id: "call_1", output: "r1" },
                    { type: "function_call", call_id: "call_2", name: "t2", arguments: "{}" },
                    { type: "function_call_output", call_id: "call_2", output: "r2" },
                ],
            };
            const out = converter.convertRequest(req) as { messages: Array<{ role: string }> };
            expect(out.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant", "user"]);
        });

        it("PC-005: Responses -> Chat non-streaming should concatenate multi-part text and multi-item reasoning", () => {
            const converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.RESPONSES, "gpt-4o")!;
            const res = converter.convertResponse({
                id: "resp_1",
                object: "response",
                created_at: 1,
                model: "gpt-4o",
                status: "completed",
                output: [
                    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "r1" }] },
                    { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "r2" }] },
                    {
                        type: "message",
                        id: "msg_1",
                        role: "assistant",
                        status: "completed",
                        content: [
                            { type: "output_text", text: "first" },
                            { type: "output_text", text: "second" },
                        ],
                    },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }) as OpenAIResponse;
            expect(res.choices[0].message.content).toBe("firstsecond");
            expect(res.choices[0].message.reasoning_content).toBe("r1\nr2");
        });

        it("PC-007: developer role, multiple system instructions, and max_completion_tokens priority", () => {
            const o2r = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.RESPONSES, "gpt-4o")!;
            const rReq = o2r.convertRequest({
                model: "gpt-4o",
                messages: [
                    { role: "developer", content: "dev rule" },
                    { role: "user", content: "hi" },
                ],
                max_tokens: 100,
                max_completion_tokens: 17,
            } as OpenAIRequest) as ResponsesRequest;
            expect(rReq.max_output_tokens).toBe(17);
            expect((rReq.input as any[])[0]).toEqual({
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: "dev rule" }],
            });

            const o2a = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const aReq = o2a.convertRequest({
                model: "claude-3-7-sonnet",
                messages: [
                    { role: "developer", content: "dev rule" },
                    { role: "user", content: "hi" },
                ],
                max_tokens: 100,
                max_completion_tokens: 17,
            } as OpenAIRequest) as { system?: string; max_tokens: number };
            expect(aReq.system).toBe("dev rule");
            expect(aReq.max_tokens).toBe(17);
            expect(() => o2a.convertRequest({
                model: "claude-3-7-sonnet",
                messages: [{ role: "user", content: "hi" }],
                max_completion_tokens: 0,
            })).toThrow();

            const r2a = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const r2aReq = r2a.convertRequest({
                model: "claude-3-7-sonnet",
                instructions: "top",
                input: [
                    { type: "message", role: "developer", content: [{ type: "input_text", text: "second" }] },
                    { type: "message", role: "system", content: [{ type: "input_text", text: "third" }] },
                    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
                ],
            }) as { system?: string };
            expect(r2aReq.system).toBe("top\n\nsecond\n\nthird");
        });

        it("PC-008: tool_choice=none should map to Anthropic { type: 'none' } and back", () => {
            const o2a = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const a1 = o2a.convertRequest({
                model: "claude-3-7-sonnet",
                messages: [{ role: "user", content: "hi" }],
                tools: [{ type: "function", function: { name: "fn", parameters: {} } }],
                tool_choice: "none",
            }) as { tool_choice?: unknown };
            expect(a1.tool_choice).toEqual({ type: "none" });

            const r2a = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, "claude-3-7-sonnet")!;
            const a2 = r2a.convertRequest({
                model: "claude-3-7-sonnet",
                input: "hi",
                tools: [{ type: "function", name: "fn", parameters: {} }],
                tool_choice: "none",
            }) as { tool_choice?: unknown };
            expect(a2.tool_choice).toEqual({ type: "none" });

            const a2o = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4o")!;
            const o1 = a2o.convertRequest({
                model: "gpt-4o",
                max_tokens: 100,
                messages: [{ role: "user", content: "hi" }],
                tool_choice: { type: "none" },
            }) as OpenAIRequest;
            expect(o1.tool_choice).toBe("none");

            const a2r = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES, "gpt-4o")!;
            const r1 = a2r.convertRequest({
                model: "gpt-4o",
                max_tokens: 100,
                messages: [{ role: "user", content: "hi" }],
                tool_choice: { type: "none" },
            }) as ResponsesRequest;
            expect(r1.tool_choice).toBe("none");
        });
    });

    describe("PC-009: Thinking signature source verification", () => {
        it("should reject raw Anthropic signature in Anthropic -> Responses request", () => {
            const a2r = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES, "gpt-4o")!;
            expect(() => a2r.convertRequest({
                model: "gpt-4o",
                max_tokens: 100,
                messages: [{
                    role: "assistant",
                    content: [{ type: "thinking", thinking: "t", signature: "raw_anthropic_sig" }],
                }],
            })).toThrow(/Incompatible or unverified/);
        });
    });
});
