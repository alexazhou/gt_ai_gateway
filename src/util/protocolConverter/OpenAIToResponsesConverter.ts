import { BaseConverter } from "./BaseConverter";
import type {
    OpenAIRequest,
    OpenAIResponse,
    OpenAIMessage,
    OpenAIChunk,
    ProtocolStreamEvent,
} from "./protocolTypes";
import type {
    ResponsesRequest,
    ResponsesNonStreamResponse,
    ResponsesInputItem,
    ResponsesOutputItem,
    ResponsesEventResponseFailed,
} from "./responsesTypes";
import {
    buildThinkingConfigFromOpenAI,
    thinkingConfigToOpenAIResponses,
} from "./thinkingConfig";

/**
 * OpenAI Chat Completions → Responses API 转换器
 *
 * 负责：
 * 1. convertRequest:  OpenAI 请求 → Responses 请求
 * 2. convertResponse: Responses 非流式响应 → OpenAI 非流式响应
 * 3. convertStreamEvent: Responses 流式 SSE → OpenAI 流式 SSE
 */
export class OpenAIToResponsesConverter extends BaseConverter {
    private isFirstChunk = true;
    private hasToolCalls = false;
    private pendingFinishReason: string | null = null;

    // ─── 请求转换 ───

    public convertRequest(req: OpenAIRequest): ResponsesRequest {
        const input: ResponsesInputItem[] = [];
        let instructions: string | undefined;

        for (const msg of req.messages) {
            if (msg.role === "system") {
                // system message → instructions
                if (typeof msg.content === "string") {
                    instructions = instructions ? `${instructions}\n${msg.content}` : msg.content;
                }
            } else if (msg.role === "user") {
                if (typeof msg.content === "string") {
                    input.push({
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: msg.content }],
                    });
                } else if (Array.isArray(msg.content)) {
                    // 多模态内容
                    const contentParts: any[] = [];
                    for (const part of msg.content as any[]) {
                        if (part.type === "text") {
                            contentParts.push({ type: "input_text", text: part.text });
                        } else if (part.type === "image_url") {
                            contentParts.push({
                                type: "input_image",
                                image_url: part.image_url.url,
                            });
                        }
                    }
                    if (contentParts.length > 0) {
                        input.push({
                            type: "message",
                            role: "user",
                            content: contentParts,
                        });
                    }
                }
            } else if (msg.role === "assistant") {
                // assistant message
                if (msg.tool_calls) {
                    // 有 tool_calls 时，分别添加文本和 function_call
                    if (msg.content && typeof msg.content === "string") {
                        input.push({
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: msg.content }],
                        });
                    }
                    for (const tc of msg.tool_calls) {
                        input.push({
                            type: "function_call",
                            call_id: tc.id,
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        });
                    }
                } else if (msg.content && typeof msg.content === "string") {
                    input.push({
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: msg.content }],
                    });
                }
            } else if (msg.role === "tool") {
                // tool message → function_call_output
                input.push({
                    type: "function_call_output",
                    call_id: msg.tool_call_id || "",
                    output: typeof msg.content === "string" ? msg.content : "",
                });
            }
        }

        const responsesReq: ResponsesRequest = {
            model: req.model,
            input,
            stream: req.stream,
        };

        if (instructions) {
            responsesReq.instructions = instructions;
        }
        if (req.max_tokens !== undefined) {
            responsesReq.max_output_tokens = req.max_tokens;
        }
        if (req.temperature !== undefined) {
            responsesReq.temperature = req.temperature;
        }
        if (req.top_p !== undefined) {
            responsesReq.top_p = req.top_p;
        }

        // tools
        if (req.tools && req.tools.length > 0) {
            responsesReq.tools = req.tools
                .filter((t) => t.type === "function")
                .map((t) => ({
                    type: "function",
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters || {},
                }));
        }

        // tool_choice
        if (req.tool_choice) {
            if (req.tool_choice === "auto") {
                responsesReq.tool_choice = "auto";
            } else if (req.tool_choice === "required") {
                responsesReq.tool_choice = "required";
            } else if (req.tool_choice === "none") {
                responsesReq.tool_choice = "none";
            } else if (typeof req.tool_choice === "object" && req.tool_choice.type === "function") {
                responsesReq.tool_choice = {
                    type: "function",
                    name: req.tool_choice.function?.name || "",
                };
            }
        }

        // reasoning_effort → reasoning
        if (req.reasoning_effort) {
            const reasoning = thinkingConfigToOpenAIResponses(
                buildThinkingConfigFromOpenAI(req.reasoning_effort),
            );
            if (reasoning) {
                responsesReq.reasoning = reasoning;
            }
        }

        return responsesReq;
    }

    // ─── 非流式响应转换 ───

    public convertResponse(upstreamRes: ResponsesNonStreamResponse, requestId?: string): OpenAIResponse {
        let content: string | null = null;
        let reasoningContent: string | null = null;
        const toolCalls: OpenAIResponse["choices"][0]["message"]["tool_calls"] = [];
        let finishReason: OpenAIResponse["choices"][0]["finish_reason"] = "stop";

        for (const item of upstreamRes.output) {
            if (item.type === "message") {
                for (const part of item.content) {
                    if (part.type === "output_text") {
                        content = part.text;
                    }
                }
            } else if (item.type === "function_call") {
                toolCalls.push({
                    id: item.call_id || item.id,
                    type: "function",
                    function: {
                        name: item.name,
                        arguments: item.arguments,
                    },
                });
                finishReason = "tool_calls";
            } else if (item.type === "reasoning") {
                const thinkingText = item.summary?.map((s) => s.text).join("\n") || "";
                if (thinkingText) {
                    reasoningContent = thinkingText;
                }
            }
        }

        const finalId = requestId || upstreamRes.id;
        const responseId = finalId.startsWith("chatcmpl-") ? finalId : `chatcmpl-${finalId.replace("resp_", "")}`;

        const inputTokens = upstreamRes.usage?.input_tokens || 0;
        const outputTokens = upstreamRes.usage?.output_tokens || 0;
        const totalTokens = upstreamRes.usage?.total_tokens || (inputTokens + outputTokens);
        const cachedTokens = upstreamRes.usage?.input_tokens_details?.cached_tokens;
        const reasoningTokens = upstreamRes.usage?.output_tokens_details?.reasoning_tokens;

        const usage: OpenAIResponse["usage"] = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: totalTokens,
        };

        if (cachedTokens !== undefined) {
            usage.prompt_tokens_details = { cached_tokens: cachedTokens };
        }
        if (reasoningTokens !== undefined) {
            usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
        }

        const message: OpenAIResponse["choices"][0]["message"] = {
            role: "assistant",
            content,
        };

        if (reasoningContent) {
            message.reasoning_content = reasoningContent;
        }
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        return {
            id: responseId,
            object: "chat.completion",
            created: upstreamRes.created_at || Math.floor(Date.now() / 1000),
            model: upstreamRes.model || this.requestModel,
            choices: [{
                index: 0,
                message,
                finish_reason: finishReason,
            }],
            usage,
        };
    }

    // ─── 流式响应转换：Responses SSE → OpenAI SSE ───

    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        const out: ProtocolStreamEvent[] = [];
        const eventType = data.type as string;

        switch (eventType) {
            case "response.created": {
                // 发送首个 chunk（包含 role）
                const response = data.response as any;
                const model = response?.model || this.requestModel;
                const id = response?.id || this.responseId;
                const chatId = id.startsWith("chatcmpl-") ? id : `chatcmpl-${id.replace("resp_", "")}`;

                out.push({
                    data: JSON.stringify({
                        id: chatId,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{
                            index: 0,
                            delta: { role: "assistant", content: "" },
                            finish_reason: null,
                        }],
                    }),
                });
                break;
            }

            case "response.output_item.added": {
                const item = data.item as any;
                if (item?.type === "function_call") {
                    this.hasToolCalls = true;
                    // 新的 tool call
                    out.push({
                        data: JSON.stringify({
                            id: this.getChatId(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: this.requestModel,
                            choices: [{
                                index: 0,
                                delta: {
                                    tool_calls: [{
                                        index: data.output_index as number || 0,
                                        id: item.call_id || item.id,
                                        type: "function",
                                        function: {
                                            name: item.name,
                                            arguments: "",
                                        },
                                    }],
                                },
                                finish_reason: null,
                            }],
                        }),
                    });
                }
                break;
            }

            case "response.output_text.delta": {
                const delta = data.delta as string;
                if (delta) {
                    out.push({
                        data: JSON.stringify({
                            id: this.getChatId(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: this.requestModel,
                            choices: [{
                                index: 0,
                                delta: { content: delta },
                                finish_reason: null,
                            }],
                        }),
                    });
                }
                break;
            }

            case "response.function_call_arguments.delta": {
                const delta = data.delta as string;
                if (delta) {
                    out.push({
                        data: JSON.stringify({
                            id: this.getChatId(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: this.requestModel,
                            choices: [{
                                index: 0,
                                delta: {
                                    tool_calls: [{
                                        index: data.output_index as number || 0,
                                        function: { arguments: delta },
                                    }],
                                },
                                finish_reason: null,
                            }],
                        }),
                    });
                }
                break;
            }

            case "response.reasoning_summary_text.delta": {
                const delta = data.delta as string;
                if (delta) {
                    out.push({
                        data: JSON.stringify({
                            id: this.getChatId(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: this.requestModel,
                            choices: [{
                                index: 0,
                                delta: { reasoning_content: delta },
                                finish_reason: null,
                            }],
                        }),
                    });
                }
                break;
            }

            case "response.output_text.done":
            case "response.function_call_arguments.done":
            case "response.reasoning_summary_text.done": {
                // 单个内容块完成，不发送 finish_reason
                break;
            }

            case "response.completed": {
                const response = data.response as any;
                const usage = response?.usage;

                // 发送 finish_reason
                const finishReason = this.hasToolCalls ? "tool_calls" : "stop";
                out.push({
                    data: JSON.stringify({
                        id: this.getChatId(),
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: this.requestModel,
                        choices: [{
                            index: 0,
                            delta: {},
                            finish_reason: finishReason,
                        }],
                    }),
                });

                // 发送 usage（单独的 chunk）
                if (usage) {
                    const inputTokens = usage.input_tokens || 0;
                    const outputTokens = usage.output_tokens || 0;
                    const totalTokens = usage.total_tokens || (inputTokens + outputTokens);
                    const cachedTokens = usage.input_tokens_details?.cached_tokens;
                    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;

                    const usageData: any = {
                        prompt_tokens: inputTokens,
                        completion_tokens: outputTokens,
                        total_tokens: totalTokens,
                    };

                    if (cachedTokens !== undefined) {
                        usageData.prompt_tokens_details = { cached_tokens: cachedTokens };
                    }
                    if (reasoningTokens !== undefined) {
                        usageData.completion_tokens_details = { reasoning_tokens: reasoningTokens };
                    }

                    out.push({
                        data: JSON.stringify({
                            id: this.getChatId(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: this.requestModel,
                            choices: [],
                            usage: usageData,
                        }),
                    });
                }

                // reset state
                this.hasToolCalls = false;
                this.isFirstChunk = true;
                break;
            }

            case "error": {
                out.push({
                    data: rawDataStr,
                    event: "error",
                });
                break;
            }

            // Responses 的模型级失败（response.status = failed）：按 OpenAI 的 error chunk 下发。
            // body 必须带 error 字段 —— OpenAI 累加器与客户端都靠它识别失败；漏掉这个事件时，
            // 客户端只看到一条被截断的流，累加器还会把请求记成成功并计费
            case "response.failed": {
                const failedEvent = data as unknown as ResponsesEventResponseFailed;
                const upstreamError = failedEvent.response?.error ?? null;
                out.push({
                    data: JSON.stringify({
                        error: upstreamError ?? { message: "Upstream response failed" },
                    }),
                    event: "error",
                });
                break;
            }
        }

        return out;
    }

    private getChatId(): string {
        const id = this.responseId;
        return id.startsWith("chatcmpl-") ? id : `chatcmpl-${id.replace("resp_", "")}`;
    }
}
