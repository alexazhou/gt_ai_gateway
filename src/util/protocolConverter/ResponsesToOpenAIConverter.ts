import customError from "../../customError";
import { BaseConverter } from "./BaseConverter";
import type { ProtocolStreamEvent } from "../protocol/commonTypes";
import type {
    OpenAIContentPart,
    OpenAIChunk,
    OpenAIMessage,
    OpenAIRequest,
    OpenAIResponse,
    OpenAIStreamError,
    OpenAITool,
} from "../protocol/openaiTypes";
import type {
    ResponsesContentPart,
    ResponsesInputItem,
    ResponsesNonStreamResponse,
    ResponsesOutputItem,
    ResponsesRequest,
} from "../protocol/responsesTypes";
import {
    buildThinkingConfigFromOpenAIResponses,
    thinkingConfigToOpenAI,
} from "./thinkingConfig";
import protocolConverterUtil, { type RawOpenAIUsage } from "./protocolConverterUtil";

/**
 * Responses API → OpenAI Chat Completions 转换器
 *
 * 负责：
 * 1. convertRequest:  Responses 请求 → OpenAI 请求
 * 2. convertResponse: OpenAI 非流式响应 → Responses 非流式响应
 * 3. convertStreamEvent: OpenAI 流式 SSE → Responses 流式 SSE
 */
export class ResponsesToOpenAIConverter extends BaseConverter {
    private currentMsgId = "";
    private messageOpen = false;
    private contentPartOpen = false;
    private textBuf = "";
    private rawUsage: RawOpenAIUsage = {};
    private reasoningActive = false;
    private reasoningItemId = "";
    private reasoningBuf = "";
    private reasoningOutputIndex = -1;
    private messageOutputIndex = -1;
    private nextOutputIndex = 0;
    private outputOrder: Array<{ kind: "reasoning" } | { kind: "message" } | { kind: "function_call"; toolIndex: number }> = [];
    private funcArgsBuf: Record<number, string> = {};
    private funcNames: Record<number, string> = {};
    private funcCallIds: Record<number, string> = {};
    private funcOutputIndices: Record<number, number> = {};
    private closedFuncIndices = new Set<number>();
    private createdEmitted = false;
    private terminalEmitted = false;
    private finishReason: string | null = null;

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

            // Responses 的 function_call_output 支持图片，但 OpenAI tool 消息只支持文本：
            // 图片先攒起来，等连续的 tool 消息全部输出完后，再作为一条 user 消息补上。
            const pendingToolImages: OpenAIContentPart[] = [];
            const flushToolImages = () => {
                if (pendingToolImages.length > 0) {
                    // splice(0) 交出副本，避免随后清空数组时把已写入消息的内容一起清掉
                    messages.push({ role: "user", content: pendingToolImages.splice(0) });
                }
            };

            for (const item of req.input) {
                if (!("type" in item && item.type === "function_call_output")) {
                    flushToolImages();
                }

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
                    const content = protocolConverterUtil.extractResponsesText(item.content, "OpenAI");
                    messages.push({
                        role: "assistant",
                        content: content || null,
                        tool_calls: pendingToolCalls,
                    });
                    pendingToolCalls = [];
                } else {
                    // 遇到其他类型，先 flush 之前收集的 tool_calls
                    flushToolCalls();
                    this.convertInputItem(item, messages, pendingToolImages);
                }
            }

            // flush 剩余的 tool_calls 与工具结果图片
            flushToolCalls();
            flushToolImages();
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
        toolImages: OpenAIContentPart[],
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
            // function_call_output → tool message；图片从数组输出中拆出，稍后放进 user 消息。
            let content = "";
            if (typeof item.output === "string") {
                content = item.output;
            } else {
                const texts: string[] = [];
                for (const part of item.output) {
                    if (part.type === "input_text" || part.type === "output_text") {
                        texts.push(part.text);
                    } else if (part.type === "input_image") {
                        const url = part.image_url || part.url || "";
                        if (!url) {
                            throw new customError.AppError(
                                "Responses input_image with file_id cannot be converted to OpenAI",
                                400,
                            );
                        }
                        toolImages.push({ type: "image_url", image_url: { url } });
                    } else if (part.type === "input_file") {
                        throw new customError.AppError(
                            "Responses input_file cannot be converted to OpenAI",
                            400,
                        );
                    }
                }
                content = texts.join("\n");
            }
            messages.push({
                role: "tool",
                tool_call_id: item.call_id,
                content,
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
                const text = protocolConverterUtil.extractResponsesText(content, "OpenAI");
                messages.push({ role: "system", content: text });
                return;
            }

            if (typeof content === "string") {
                messages.push({ role: role as "user" | "assistant", content });
                return;
            }

            if (Array.isArray(content)) {
                // 按原始顺序构建内容块，保留 text → image → text 的多模态语义
                const parts: OpenAIContentPart[] = [];
                let hasImage = false;

                for (const part of content) {
                    if (part.type === "input_text" || part.type === "output_text") {
                        parts.push({ type: "text", text: part.text });
                    } else if (part.type === "input_image") {
                        const url = part.image_url || part.url || "";
                        if (!url) {
                            throw new customError.AppError(
                                "Responses input_image with file_id cannot be converted to OpenAI",
                                400,
                            );
                        }
                        hasImage = true;
                        parts.push({
                            type: "image_url",
                            image_url: { url },
                        });
                    } else if (part.type === "input_file") {
                        throw new customError.AppError(
                            "Responses input_file cannot be converted to OpenAI",
                            400,
                        );
                    }
                }

                if (hasImage) {
                    messages.push({ role: role as "user" | "assistant", content: parts });
                } else if (parts.length > 0) {
                    // 纯文本时保持原有拼接行为
                    const texts = parts
                        .filter((part): part is { type: "text"; text: string } => part.type === "text")
                        .map((part) => part.text)
                        .join("\n");
                    messages.push({ role: role as "user" | "assistant", content: texts });
                }
            }
        }
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
        const { status, incompleteDetails } = this.mapFinishReason(finishReason);

        return {
            id: responseId,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status,
            ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
            model: upstreamRes.model,
            output,
            usage: protocolConverterUtil.openAIUsageToResponses(
                protocolConverterUtil.mergeOpenAIUsage({}, upstreamRes.usage),
            ),
        };
    }

    // ─── 流式响应转换：OpenAI SSE → Responses SSE ───

    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        if (this.terminalEmitted) {
            return [];
        }
        const out: ProtocolStreamEvent[] = [];
        const chunk = data as unknown as OpenAIChunk;

        // 上游在流里报错：必须转成 Responses 的 error 事件，客户端和累加器都按它认失败。
        // 放在最前面：别在报错之前先补发 response.created / response.in_progress。
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
                    this.reasoningOutputIndex = this.nextOutputIndex++;
                    this.outputOrder.push({ kind: "reasoning" });
                    this.reasoningItemId = `rs_${this.responseId}_${this.reasoningOutputIndex}`;
                    this.reasoningBuf = "";

                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: this.reasoningOutputIndex,
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
                            output_index: this.reasoningOutputIndex,
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
                        output_index: this.reasoningOutputIndex,
                        summary_index: 0,
                        delta: delta.reasoning_content,
                    }),
                });
            }

            // delta.content → message
            if (delta?.content) {
                if (!this.messageOpen) {
                    this.messageOutputIndex = this.nextOutputIndex++;
                    this.outputOrder.push({ kind: "message" });
                    this.currentMsgId = `msg_${this.responseId}_${this.messageOutputIndex}`;
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: this.messageOutputIndex,
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
                            output_index: this.messageOutputIndex,
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
                        output_index: this.messageOutputIndex,
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
                        const outIdx = this.nextOutputIndex++;
                        this.funcOutputIndices[idx] = outIdx;
                        this.outputOrder.push({ kind: "function_call", toolIndex: idx });
                        this.funcCallIds[idx] = tc.id;
                        this.funcNames[idx] = tc.function?.name || "";
                        this.funcArgsBuf[idx] = "";

                        out.push({
                            data: JSON.stringify({
                                type: "response.output_item.added",
                                sequence_number: this.nextSeq(),
                                output_index: outIdx,
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
                        const outIdx = this.funcOutputIndices[idx] ?? idx;
                        this.funcArgsBuf[idx] = (this.funcArgsBuf[idx] || "") + tc.function.arguments;
                        out.push({
                            data: JSON.stringify({
                                type: "response.function_call_arguments.delta",
                                sequence_number: this.nextSeq(),
                                item_id: `fc_${this.funcCallIds[idx]}`,
                                output_index: outIdx,
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
                            output_index: this.reasoningOutputIndex,
                            summary_index: 0,
                            text: this.reasoningBuf,
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_part.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.reasoningItemId,
                            output_index: this.reasoningOutputIndex,
                            summary_index: 0,
                            part: { type: "summary_text", text: this.reasoningBuf },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: this.reasoningOutputIndex,
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
                            output_index: this.messageOutputIndex,
                            content_index: 0,
                            text: this.textBuf,
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.content_part.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.currentMsgId,
                            output_index: this.messageOutputIndex,
                            content_index: 0,
                            part: { type: "output_text", text: this.textBuf },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: this.messageOutputIndex,
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
                    if (this.closedFuncIndices.has(i)) continue;
                    this.closedFuncIndices.add(i);
                    const outIdx = this.funcOutputIndices[i] ?? i;
                    out.push({
                        data: JSON.stringify({
                            type: "response.function_call_arguments.done",
                            sequence_number: this.nextSeq(),
                            item_id: `fc_${this.funcCallIds[i]}`,
                            output_index: outIdx,
                            arguments: this.funcArgsBuf[i] || "{}",
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: outIdx,
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

        // usage 帧仅累积原始字段，不提前结束流（等待 [DONE] 或干净 EOF 统一收尾）
        if (chunk.usage) {
            protocolConverterUtil.mergeOpenAIUsage(this.rawUsage, chunk.usage);
        }

        return out;
    }

    public override onUpstreamEnd(): ProtocolStreamEvent[] {
        // 上游给过 finish_reason 却没发 [DONE]：补发终止事件；已发过终止事件则幂等返回空
        return (this.finishReason !== null && !this.terminalEmitted) ? this.handleDoneEvent() : [];
    }


    private mapFinishReason(finishReason: string | null | undefined): {
        status: "completed" | "incomplete";
        incompleteDetails?: { reason: "max_output_tokens" | "content_filter" };
    } {
        if (finishReason === "length") {
            return { status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } };
        }
        if (finishReason === "content_filter") {
            return { status: "incomplete", incompleteDetails: { reason: "content_filter" } };
        }
        return { status: "completed" };
    }


    protected override handleDoneEvent(): ProtocolStreamEvent[] {
        const out: ProtocolStreamEvent[] = [];

        // 如果还没有生成终止事件，在 [DONE]（或带 finish_reason 的干净 EOF）时统一收尾
        if (this.createdEmitted && !this.terminalEmitted) {
            // 收尾未关闭的 block
            if (this.reasoningActive) {
                out.push({
                    data: JSON.stringify({
                        type: "response.reasoning_summary_text.done",
                        sequence_number: this.nextSeq(),
                        item_id: this.reasoningItemId,
                        output_index: this.reasoningOutputIndex,
                        summary_index: 0,
                        text: this.reasoningBuf,
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.reasoning_summary_part.done",
                        sequence_number: this.nextSeq(),
                        item_id: this.reasoningItemId,
                        output_index: this.reasoningOutputIndex,
                        summary_index: 0,
                        part: { type: "summary_text", text: this.reasoningBuf },
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.output_item.done",
                        sequence_number: this.nextSeq(),
                        output_index: this.reasoningOutputIndex,
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
                        output_index: this.messageOutputIndex,
                        content_index: 0,
                        text: this.textBuf,
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.content_part.done",
                        sequence_number: this.nextSeq(),
                        item_id: this.currentMsgId,
                        output_index: this.messageOutputIndex,
                        content_index: 0,
                        part: { type: "output_text", text: this.textBuf },
                    }),
                });
                out.push({
                    data: JSON.stringify({
                        type: "response.output_item.done",
                        sequence_number: this.nextSeq(),
                        output_index: this.messageOutputIndex,
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
                if (!this.closedFuncIndices.has(i)) {
                    this.closedFuncIndices.add(i);
                    const outIdx = this.funcOutputIndices[i] ?? i;
                    out.push({
                        data: JSON.stringify({
                            type: "response.function_call_arguments.done",
                            sequence_number: this.nextSeq(),
                            item_id: `fc_${this.funcCallIds[i]}`,
                            output_index: outIdx,
                            arguments: this.funcArgsBuf[i] || "{}",
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: outIdx,
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

            // 生成终止事件（response.completed 或 response.incomplete），保持与已发出事件一致的顺序
            const outputArr: ResponsesOutputItem[] = [];
            for (const entry of this.outputOrder) {
                if (entry.kind === "reasoning" && this.reasoningBuf) {
                    outputArr.push({
                        id: this.reasoningItemId,
                        type: "reasoning",
                        summary: [{ type: "summary_text", text: this.reasoningBuf }],
                    });
                } else if (entry.kind === "message" && this.textBuf) {
                    outputArr.push({
                        id: this.currentMsgId,
                        type: "message",
                        status: "completed",
                        content: [{ type: "output_text", text: this.textBuf }],
                        role: "assistant",
                    });
                } else if (entry.kind === "function_call") {
                    const i = entry.toolIndex;
                    outputArr.push({
                        id: `fc_${this.funcCallIds[i]}`,
                        type: "function_call",
                        status: "completed",
                        arguments: this.funcArgsBuf[i] || "{}",
                        call_id: this.funcCallIds[i],
                        name: this.funcNames[i] || "",
                    });
                }
            }

            const { status, incompleteDetails } = this.mapFinishReason(this.finishReason);
            const terminalType = status === "incomplete" ? "response.incomplete" : "response.completed";

            out.push({
                data: JSON.stringify({
                    type: terminalType,
                    sequence_number: this.nextSeq(),
                    response: {
                        id: this.responseId,
                        object: "response",
                        created_at: Math.floor(Date.now() / 1000),
                        status,
                        ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
                        model: this.requestModel,
                        output: outputArr,
                        usage: protocolConverterUtil.openAIUsageToResponses(this.rawUsage),
                    },
                }),
            });

            this.terminalEmitted = true;
            this.finishReason = null;
        }

        return out;
    }

    private resetState(): void {
        this.seq = 0;
        this.currentMsgId = "";
        this.messageOpen = false;
        this.contentPartOpen = false;
        this.textBuf = "";
        this.rawUsage = {};
        this.reasoningActive = false;
        this.reasoningItemId = "";
        this.reasoningBuf = "";
        this.reasoningOutputIndex = -1;
        this.messageOutputIndex = -1;
        this.nextOutputIndex = 0;
        this.outputOrder = [];
        this.funcArgsBuf = {};
        this.funcNames = {};
        this.funcCallIds = {};
        this.funcOutputIndices = {};
        this.closedFuncIndices.clear();
        this.createdEmitted = false;
        this.terminalEmitted = false;
        this.finishReason = null;
    }
}
