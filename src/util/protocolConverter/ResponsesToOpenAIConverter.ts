import { BaseConverter } from "./BaseConverter";
import type {
    OpenAIRequest,
    OpenAIResponse,
    OpenAIMessage,
    OpenAITool,
    OpenAIChunk,
    OpenAIStreamError,
    ProtocolStreamEvent,
} from "./protocolTypes";
import type {
    ResponsesRequest,
    ResponsesInputItem,
    ResponsesNonStreamResponse,
    ResponsesContentPart,
} from "./responsesTypes";
import {
    buildThinkingConfigFromOpenAIResponses,
    thinkingConfigToOpenAI,
} from "./thinkingConfig";

/**
 * Responses API → OpenAI Chat Completions 转换器
 *
 * 负责：
 * 1. convertRequest:  Responses 请求 → OpenAI 请求
 * 2. convertResponse: OpenAI 非流式响应 → Responses 非流式响应
 * 3. convertStreamEvent: OpenAI 流式 SSE → Responses 流式 SSE
 */
export class ResponsesToOpenAIConverter extends BaseConverter {
    private seq = 0;
    private currentMsgId = "";
    private messageOpen = false;
    private contentPartOpen = false;
    private textBuf = "";
    private inputTokens = 0;
    private outputTokens = 0;
    private cacheReadTokens = 0;
    private reasoningActive = false;
    private reasoningItemId = "";
    private reasoningBuf = "";
    private reasoningIndex = 0;
    private funcArgsBuf: Record<number, string> = {};
    private funcNames: Record<number, string> = {};
    private funcCallIds: Record<number, string> = {};
    private createdEmitted = false;
    private finishReason: string | null = null;

    private nextSeq(): number {
        return ++this.seq;
    }

    // ─── 请求转换 ───

    public convertRequest(req: ResponsesRequest): OpenAIRequest {
        const messages: OpenAIMessage[] = [];

        // instructions → system message
        if (req.instructions) {
            messages.push({ role: "system", content: req.instructions });
        }

        if (typeof req.input === "string") {
            messages.push({ role: "user", content: req.input });
        } else {
            // 先收集连续的 function_call，合并到一个 assistant 消息
            let pendingToolCalls: OpenAIMessage["tool_calls"] = [];

            const flushToolCalls = () => {
                if (pendingToolCalls && pendingToolCalls.length > 0) {
                    // 如果前一个消息是 assistant (content)，合并到一起
                    const lastMsg = messages[messages.length - 1];
                    if (lastMsg && lastMsg.role === "assistant" && lastMsg.content && !lastMsg.tool_calls) {
                        lastMsg.tool_calls = pendingToolCalls;
                    } else {
                        messages.push({
                            role: "assistant",
                            content: null,
                            tool_calls: pendingToolCalls,
                        });
                    }
                    pendingToolCalls = [];
                }
            };

            for (const item of req.input) {
                if ("type" in item && item.type === "function_call") {
                    // 收集 function_call
                    if (!pendingToolCalls) {
                        pendingToolCalls = [];
                    }
                    pendingToolCalls.push({
                        id: item.call_id || `call_${Date.now()}`,
                        type: "function",
                        function: {
                            name: item.name,
                            arguments: item.arguments,
                        },
                    });
                } else if ("role" in item && item.role === "assistant" && pendingToolCalls.length > 0) {
                    // 如果是 message assistant 且有 pendingToolCalls，合并到一起
                    const content = this.extractText(item.content);
                    messages.push({
                        role: "assistant",
                        content: content || null,
                        tool_calls: pendingToolCalls,
                    });
                    pendingToolCalls = [];
                } else {
                    // 遇到其他类型，先 flush 之前收集的 tool_calls
                    flushToolCalls();
                    this.convertInputItem(item, messages);
                }
            }

            // flush 剩余的 tool_calls
            flushToolCalls();
        }

        const openaiReq: OpenAIRequest = {
            model: req.model,
            messages,
            stream: req.stream,
        };

        if (req.max_output_tokens !== undefined) {
            openaiReq.max_tokens = req.max_output_tokens;
        }
        if (req.temperature !== undefined) {
            openaiReq.temperature = req.temperature;
        }
        if (req.top_p !== undefined) {
            openaiReq.top_p = req.top_p;
        }

        // tools（只保留 function 类型的工具）
        if (req.tools && req.tools.length > 0) {
            openaiReq.tools = req.tools
                .filter((t) => t.type === "function" && !!t.name)
                .map((t) => ({
                    type: "function" as const,
                    function: {
                        name: t.name!,
                        description: t.description,
                        parameters: t.parameters || {},
                    },
                }));
        }

        // tool_choice
        if (req.tool_choice) {
            if (req.tool_choice === "auto") {
                openaiReq.tool_choice = "auto";
            } else if (req.tool_choice === "required") {
                openaiReq.tool_choice = "required";
            } else if (req.tool_choice === "none") {
                openaiReq.tool_choice = "none";
            } else if (typeof req.tool_choice === "object" && req.tool_choice.type === "function") {
                openaiReq.tool_choice = {
                    type: "function",
                    function: { name: req.tool_choice.name },
                };
            }
        }

        // reasoning.effort → reasoning_effort
        const reasoningEffort = thinkingConfigToOpenAI(
            buildThinkingConfigFromOpenAIResponses(req.reasoning),
        );
        if (reasoningEffort) {
            openaiReq.reasoning_effort = reasoningEffort;
        }

        return openaiReq;
    }

    private convertInputItem(
        item: ResponsesInputItem,
        messages: OpenAIMessage[],
    ): void {
        if ("type" in item && item.type === "function_call") {
            // function_call → assistant message with tool_calls
            messages.push({
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: item.call_id || `call_${Date.now()}`,
                    type: "function",
                    function: {
                        name: item.name,
                        arguments: item.arguments,
                    },
                }],
            });
            return;
        }

        if ("type" in item && item.type === "function_call_output") {
            // function_call_output → tool message
            messages.push({
                role: "tool",
                tool_call_id: item.call_id,
                content: item.output,
            });
            return;
        }

        if ("type" in item && item.type === "reasoning") {
            // reasoning → 跳过（OpenAI Chat Completions 没有等价输入项）
            return;
        }

        // message item
        if ("role" in item) {
            const role = item.role;
            const content = item.content;

            if (role === "system" || role === "developer") {
                // system/developer message → system message
                const text = this.extractText(content);
                messages.push({ role: "system", content: text });
                return;
            }

            if (typeof content === "string") {
                messages.push({ role: role as "user" | "assistant", content });
                return;
            }

            if (Array.isArray(content)) {
                // 检查是否包含图片
                const hasImage = content.some((p) => p.type === "input_image");
                const texts: string[] = [];
                const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];

                for (const part of content) {
                    if (part.type === "input_text" || part.type === "output_text") {
                        texts.push(part.text);
                    } else if (part.type === "input_image") {
                        const url = (part as any).image_url || (part as any).url || "";
                        imageParts.push({
                            type: "image_url",
                            image_url: { url },
                        });
                    }
                }

                if (imageParts.length > 0) {
                    // 多模态内容
                    const multiContent: any[] = [];
                    if (texts.length > 0) {
                        multiContent.push({ type: "text", text: texts.join("\n") });
                    }
                    multiContent.push(...imageParts);
                    messages.push({ role: role as "user" | "assistant", content: multiContent as any });
                } else if (texts.length > 0) {
                    messages.push({ role: role as "user" | "assistant", content: texts.join("\n") });
                }
            }
        }
    }

    private extractText(content: string | ResponsesContentPart[]): string {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
            .filter((p: any) => p.type === "input_text" || p.type === "output_text")
            .map((p: any) => p.text)
            .join("\n");
    }

    // ─── 非流式响应转换 ───

    public convertResponse(upstreamRes: OpenAIResponse, requestId?: string): ResponsesNonStreamResponse {
        const output: ResponsesNonStreamResponse["output"] = [];
        const responseId = requestId || upstreamRes.id || `resp_${Date.now()}`;
        const message = upstreamRes.choices?.[0]?.message;

        if (message?.content) {
            output.push({
                type: "message",
                id: `msg_${responseId}_0`,
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: message.content }],
            });
        }

        if (message?.reasoning_content) {
            output.push({
                type: "reasoning",
                id: `rs_${responseId}_0`,
                summary: [{ type: "summary_text", text: message.reasoning_content }],
            });
        }

        if (message?.tool_calls) {
            for (const tc of message.tool_calls) {
                output.push({
                    type: "function_call",
                    id: `fc_${tc.id}`,
                    call_id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                    status: "completed",
                });
            }
        }

        const finishReason = upstreamRes.choices?.[0]?.finish_reason;
        const status = (finishReason === "stop" || finishReason === "tool_calls" || finishReason === "length" || finishReason === "content_filter")
            ? "completed"
            : "completed"; // OpenAI 没有显式 failed finish_reason

        return {
            id: responseId,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status,
            model: upstreamRes.model,
            output,
            usage: {
                input_tokens: upstreamRes.usage?.prompt_tokens || 0,
                output_tokens: upstreamRes.usage?.completion_tokens || 0,
                total_tokens: upstreamRes.usage?.total_tokens || 0,
                input_tokens_details: upstreamRes.usage?.prompt_tokens_details?.cached_tokens
                    ? { cached_tokens: upstreamRes.usage.prompt_tokens_details.cached_tokens }
                    : undefined,
                output_tokens_details: upstreamRes.usage?.completion_tokens_details?.reasoning_tokens
                    ? { reasoning_tokens: upstreamRes.usage.completion_tokens_details.reasoning_tokens }
                    : undefined,
            },
        };
    }

    // ─── 流式响应转换：OpenAI SSE → Responses SSE ───

    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        const out: ProtocolStreamEvent[] = [];
        const chunk = data as unknown as OpenAIChunk;

        // 上游在流内报错：OpenAI 兼容上游把错误放在 chunk 的 error 字段里（有的还会给 type: "error"）。
        // 必须翻译成 Responses 的 error 事件，客户端与 Responses 累加器都按 type: "error" 识别失败；
        // 漏掉时客户端只看到一条被截断的流，而若此前已收到 finish_reason，onUpstreamEnd 还会补发
        // response.completed，把请求记成成功并计费。放在最前面，避免报错前先补发 created / in_progress
        const streamError = data as unknown as OpenAIStreamError;
        const errorDetail = "error" in streamError
            ? streamError.error
            : streamError.type === "error" ? streamError : null;
        if (errorDetail) {
            out.push({
                event: "error",
                data: JSON.stringify({
                    type: "error",
                    code: errorDetail.code ?? null,
                    message: errorDetail.message ?? "Upstream error",
                }),
            });
            return out;
        }

        // 首帧：发 response.created + response.in_progress
        if (!this.createdEmitted) {
            this.createdEmitted = true;
            if (chunk.model) this.updateModel(chunk.model);
            if (chunk.id) {
                this.responseId = chunk.id.startsWith("resp_") ? chunk.id : `resp_${chunk.id.replace("chatcmpl-", "")}`;
            }

            out.push({
                data: JSON.stringify({
                    type: "response.created",
                    sequence_number: this.nextSeq(),
                    response: {
                        id: this.responseId,
                        object: "response",
                        created_at: Math.floor(Date.now() / 1000),
                        status: "in_progress",
                        output: [],
                    },
                }),
            });
            out.push({
                data: JSON.stringify({
                    type: "response.in_progress",
                    sequence_number: this.nextSeq(),
                    response: { id: this.responseId, status: "in_progress" },
                }),
            });
        }

        if (chunk.choices && chunk.choices.length > 0) {
            const delta = chunk.choices[0].delta;
            const finishReason = chunk.choices[0].finish_reason;

            // delta.reasoning_content → reasoning
            if (delta?.reasoning_content) {
                if (!this.reasoningActive) {
                    this.reasoningActive = true;
                    this.reasoningItemId = `rs_${this.responseId}_0`;
                    this.reasoningBuf = "";
                    this.reasoningIndex = 0;

                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: 0,
                            item: {
                                id: this.reasoningItemId,
                                type: "reasoning",
                                status: "in_progress",
                                summary: [],
                            },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_part.added",
                            sequence_number: this.nextSeq(),
                            item_id: this.reasoningItemId,
                            output_index: 0,
                            summary_index: 0,
                            part: { type: "summary_text", text: "" },
                        }),
                    });
                }

                this.reasoningBuf += delta.reasoning_content;
                out.push({
                    data: JSON.stringify({
                        type: "response.reasoning_summary_text.delta",
                        sequence_number: this.nextSeq(),
                        item_id: this.reasoningItemId,
                        output_index: 0,
                        summary_index: 0,
                        delta: delta.reasoning_content,
                    }),
                });
            }

            // delta.content → message
            if (delta?.content) {
                if (!this.messageOpen) {
                    this.currentMsgId = `msg_${this.responseId}_0`;
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: 0,
                            item: {
                                id: this.currentMsgId,
                                type: "message",
                                status: "in_progress",
                                content: [],
                                role: "assistant",
                            },
                        }),
                    });
                    this.messageOpen = true;
                }

                if (!this.contentPartOpen) {
                    out.push({
                        data: JSON.stringify({
                            type: "response.content_part.added",
                            sequence_number: this.nextSeq(),
                            item_id: this.currentMsgId,
                            output_index: 0,
                            content_index: 0,
                            part: { type: "output_text", text: "" },
                        }),
                    });
                    this.contentPartOpen = true;
                }

                this.textBuf += delta.content;
                out.push({
                    data: JSON.stringify({
                        type: "response.output_text.delta",
                        sequence_number: this.nextSeq(),
                        item_id: this.currentMsgId,
                        output_index: 0,
                        content_index: 0,
                        delta: delta.content,
                    }),
                });
            }

            // delta.tool_calls → function_call
            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;

                    if (tc.id && !this.funcCallIds[idx]) {
                        // 新的 tool call
                        this.funcCallIds[idx] = tc.id;
                        this.funcNames[idx] = tc.function?.name || "";
                        this.funcArgsBuf[idx] = "";

                        out.push({
                            data: JSON.stringify({
                                type: "response.output_item.added",
                                sequence_number: this.nextSeq(),
                                output_index: idx,
                                item: {
                                    id: `fc_${tc.id}`,
                                    type: "function_call",
                                    status: "in_progress",
                                    arguments: "",
                                    call_id: tc.id,
                                    name: tc.function?.name || "",
                                },
                            }),
                        });
                    }

                    if (tc.function?.arguments) {
                        this.funcArgsBuf[idx] = (this.funcArgsBuf[idx] || "") + tc.function.arguments;
                        out.push({
                            data: JSON.stringify({
                                type: "response.function_call_arguments.delta",
                                sequence_number: this.nextSeq(),
                                item_id: `fc_${this.funcCallIds[idx]}`,
                                output_index: idx,
                                delta: tc.function.arguments,
                            }),
                        });
                    }
                }
            }

            // finish_reason → 收尾各 open block
            if (finishReason) {
                this.finishReason = finishReason;

                // 收尾 reasoning
                if (this.reasoningActive) {
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_text.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.reasoningItemId,
                            output_index: 0,
                            summary_index: 0,
                            text: this.reasoningBuf,
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_part.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.reasoningItemId,
                            output_index: 0,
                            summary_index: 0,
                            part: { type: "summary_text", text: this.reasoningBuf },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: 0,
                            item: {
                                id: this.reasoningItemId,
                                type: "reasoning",
                                summary: this.reasoningBuf ? [{ type: "summary_text", text: this.reasoningBuf }] : [],
                            },
                        }),
                    });
                    this.reasoningActive = false;
                }

                // 收尾 message
                if (this.messageOpen) {
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_text.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.currentMsgId,
                            output_index: 0,
                            content_index: 0,
                            text: this.textBuf,
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.content_part.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.currentMsgId,
                            output_index: 0,
                            content_index: 0,
                            part: { type: "output_text", text: this.textBuf },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: 0,
                            item: {
                                id: this.currentMsgId,
                                type: "message",
                                status: "completed",
                                content: [{ type: "output_text", text: this.textBuf }],
                                role: "assistant",
                            },
                        }),
                    });
                    this.messageOpen = false;
                    this.contentPartOpen = false;
                }

                // 收尾 function_calls
                const indices = Object.keys(this.funcCallIds).map(Number).sort((a, b) => a - b);
                for (const i of indices) {
                    out.push({
                        data: JSON.stringify({
                            type: "response.function_call_arguments.done",
                            sequence_number: this.nextSeq(),
                            item_id: `fc_${this.funcCallIds[i]}`,
                            output_index: i,
                            arguments: this.funcArgsBuf[i] || "{}",
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: i,
                            item: {
                                id: `fc_${this.funcCallIds[i]}`,
                                type: "function_call",
                                status: "completed",
                                arguments: this.funcArgsBuf[i] || "{}",
                                call_id: this.funcCallIds[i],
                                name: this.funcNames[i] || "",
                            },
                        }),
                    });
                }
            }
        }

        // usage 帧 → response.completed
        if (chunk.usage) {
            this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
            this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
            const cachedTokens = (chunk.usage as any).prompt_tokens_details?.cached_tokens;
            if (cachedTokens !== undefined) {
                this.cacheReadTokens = cachedTokens;
            }

            const outputArr: any[] = [];
            if (this.textBuf) {
                outputArr.push({
                    id: this.currentMsgId,
                    type: "message",
                    status: "completed",
                    content: [{ type: "output_text", text: this.textBuf }],
                    role: "assistant",
                });
            }
            if (this.reasoningBuf) {
                outputArr.push({
                    id: this.reasoningItemId,
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: this.reasoningBuf }],
                });
            }
            const funcIndices = Object.keys(this.funcCallIds).map(Number).sort((a, b) => a - b);
            for (const i of funcIndices) {
                outputArr.push({
                    id: `fc_${this.funcCallIds[i]}`,
                    type: "function_call",
                    status: "completed",
                    arguments: this.funcArgsBuf[i] || "{}",
                    call_id: this.funcCallIds[i],
                    name: this.funcNames[i] || "",
                });
            }

            const status = (this.finishReason === "stop" || this.finishReason === "tool_calls" || this.finishReason === "length" || this.finishReason === "content_filter")
                ? "completed"
                : "completed";

            out.push({
                data: JSON.stringify({
                    type: "response.completed",
                    sequence_number: this.nextSeq(),
                    response: {
                        id: this.responseId,
                        object: "response",
                        created_at: Math.floor(Date.now() / 1000),
                        status,
                        model: this.requestModel,
                        output: outputArr,
                        usage: {
                            input_tokens: this.inputTokens,
                            input_tokens_details: this.cacheReadTokens ? {
                                cached_tokens: this.cacheReadTokens,
                            } : undefined,
                            output_tokens: this.outputTokens,
                            total_tokens: this.inputTokens + this.cacheReadTokens + this.outputTokens,
                        },
                    },
                }),
            });

            // reset state
            this.resetState();
        }

        return out;
    }

    public override onUpstreamEnd(): ProtocolStreamEvent[] {
        // 上游给过 finish_reason 却没收尾：补发 response.completed。
        // 正常收尾（usage 帧已发 response.completed）时 resetState 已把 finishReason 清空 →
        // 这里返回空，不重复补发。
        return this.finishReason !== null ? this.handleDoneEvent() : [];
    }


    protected override handleDoneEvent(): ProtocolStreamEvent[] {
        const out: ProtocolStreamEvent[] = [];

        // 如果还没有生成 response.completed，在 [DONE] 时兜底生成
        if (this.createdEmitted) {
            // 收尾未关闭的 block
            if (this.reasoningActive) {
                out.push({
                    data: JSON.stringify({
                        type: "response.reasoning_summary_text.done",
                        sequence_number: this.nextSeq(),
                        item_id: this.reasoningItemId,
                        output_index: 0,
                        summary_index: 0,
                        text: this.reasoningBuf,
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.reasoning_summary_part.done",
                        sequence_number: this.nextSeq(),
                        item_id: this.reasoningItemId,
                        output_index: 0,
                        summary_index: 0,
                        part: { type: "summary_text", text: this.reasoningBuf },
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.output_item.done",
                        sequence_number: this.nextSeq(),
                        output_index: 0,
                        item: {
                            id: this.reasoningItemId,
                            type: "reasoning",
                            summary: this.reasoningBuf ? [{ type: "summary_text", text: this.reasoningBuf }] : [],
                        },
                    }),
                });
                this.reasoningActive = false;
            }

            if (this.messageOpen) {
                out.push({
                    data: JSON.stringify({
                        type: "response.output_text.done",
                        sequence_number: this.nextSeq(),
                        item_id: this.currentMsgId,
                        output_index: 0,
                        content_index: 0,
                        text: this.textBuf,
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.content_part.done",
                        sequence_number: this.nextSeq(),
                        item_id: this.currentMsgId,
                        output_index: 0,
                        content_index: 0,
                        part: { type: "output_text", text: this.textBuf },
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.output_item.done",
                        sequence_number: this.nextSeq(),
                        output_index: 0,
                        item: {
                            id: this.currentMsgId,
                            type: "message",
                            status: "completed",
                            content: [{ type: "output_text", text: this.textBuf }],
                            role: "assistant",
                        },
                    }),
                });
                this.messageOpen = false;
                this.contentPartOpen = false;
            }

            const funcIndices = Object.keys(this.funcCallIds).map(Number).sort((a, b) => a - b);
            for (const i of funcIndices) {
                out.push({
                    data: JSON.stringify({
                        type: "response.function_call_arguments.done",
                        sequence_number: this.nextSeq(),
                        item_id: `fc_${this.funcCallIds[i]}`,
                        output_index: i,
                        arguments: this.funcArgsBuf[i] || "{}",
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.output_item.done",
                        sequence_number: this.nextSeq(),
                        output_index: i,
                        item: {
                            id: `fc_${this.funcCallIds[i]}`,
                            type: "function_call",
                            status: "completed",
                            arguments: this.funcArgsBuf[i] || "{}",
                            call_id: this.funcCallIds[i],
                            name: this.funcNames[i] || "",
                        },
                    }),
                });
            }

            // 生成 response.completed
            const outputArr: any[] = [];
            if (this.textBuf) {
                outputArr.push({
                    id: this.currentMsgId,
                    type: "message",
                    status: "completed",
                    content: [{ type: "output_text", text: this.textBuf }],
                    role: "assistant",
                });
            }
            if (this.reasoningBuf) {
                outputArr.push({
                    id: this.reasoningItemId,
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: this.reasoningBuf }],
                });
            }
            for (const i of funcIndices) {
                outputArr.push({
                    id: `fc_${this.funcCallIds[i]}`,
                    type: "function_call",
                    status: "completed",
                    arguments: this.funcArgsBuf[i] || "{}",
                    call_id: this.funcCallIds[i],
                    name: this.funcNames[i] || "",
                });
            }

            const status = (this.finishReason === "stop" || this.finishReason === "tool_calls" || this.finishReason === "length" || this.finishReason === "content_filter")
                ? "completed"
                : "completed";

            out.push({
                data: JSON.stringify({
                    type: "response.completed",
                    sequence_number: this.nextSeq(),
                    response: {
                        id: this.responseId,
                        object: "response",
                        created_at: Math.floor(Date.now() / 1000),
                        status,
                        model: this.requestModel,
                        output: outputArr,
                        usage: {
                            input_tokens: this.inputTokens,
                            input_tokens_details: this.cacheReadTokens ? {
                                cached_tokens: this.cacheReadTokens,
                            } : undefined,
                            output_tokens: this.outputTokens,
                            total_tokens: this.inputTokens + this.cacheReadTokens + this.outputTokens,
                        },
                    },
                }),
            });

            this.resetState();
        }

        return out;
    }

    private resetState(): void {
        this.seq = 0;
        this.currentMsgId = "";
        this.messageOpen = false;
        this.contentPartOpen = false;
        this.textBuf = "";
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.cacheReadTokens = 0;
        this.reasoningActive = false;
        this.reasoningItemId = "";
        this.reasoningBuf = "";
        this.reasoningIndex = 0;
        this.funcArgsBuf = {};
        this.funcNames = {};
        this.funcCallIds = {};
        this.createdEmitted = false;
        this.finishReason = null;
    }
}
