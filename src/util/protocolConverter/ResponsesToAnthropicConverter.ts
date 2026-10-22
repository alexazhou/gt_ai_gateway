import customError from "../../customError";
import { BaseConverter } from "./BaseConverter";
import type {
    AnthropicContentBlock,
    AnthropicRequest,
    AnthropicResponse,
    AnthropicStreamContentBlock,
    AnthropicStreamDelta,
    AnthropicStreamMessage,
    AnthropicStreamUsage,
    AnthropicTool,
} from "../protocol/anthropicTypes";
import type { ProtocolStreamEvent } from "../protocol/commonTypes";
import type {
    ResponsesContentPart,
    ResponsesInputItem,
    ResponsesNonStreamResponse,
    ResponsesOutputItem,
    ResponsesRequest,
} from "../protocol/responsesTypes";
import {
    buildThinkingConfigFromOpenAIResponses,
    thinkingConfigToAnthropic,
} from "./thinkingConfig";
import protocolConverterUtil from "./protocolConverterUtil";
import { resolveAnthropicMaxTokens } from "./anthropicDefaults";

/**
 * Responses API → Anthropic 转换器
 *
 * 负责：
 * 1. convertRequest:  Responses 请求 → Anthropic 请求
 * 2. convertResponse: Anthropic 非流式响应 → Responses 非流式响应
 * 3. convertStreamEvent: Anthropic 流式 SSE → Responses 流式 SSE
 */
export class ResponsesToAnthropicConverter extends BaseConverter {
    private currentMsgId = "";
    private currentFcId = "";
    private inTextBlock = false;
    private inFuncBlock = false;
    private messageOpen = false;
    private contentPartOpen = false;
    private textBuf = "";
    private funcArgsBuf: Record<number, string> = {};
    private funcNames: Record<number, string> = {};
    private funcCallIds: Record<number, string> = {};
    private reasoningActive = false;
    private reasoningItemId = "";
    private reasoningBuf = "";
    private reasoningSignature = "";
    private reasoningIndex = 0;
    private inputTokens = 0;
    private outputTokens = 0;
    private cacheReadTokens = 0;
    private currentToolCallIndex = -1;

    // ─── 请求转换 ───

    public convertRequest(req: ResponsesRequest): AnthropicRequest {
        const messages: AnthropicRequest["messages"] = [];
        let systemText = "";

        // instructions → system
        if (req.instructions) {
            systemText = req.instructions;
        }

        if (typeof req.input === "string") {
            messages.push({ role: "user", content: req.input });
        } else {
            // 合并连续的 function_call 和 function_call_output
            let pendingToolUses: AnthropicContentBlock[] = [];
            let pendingToolResults: AnthropicContentBlock[] = [];

            const flushToolUses = () => {
                if (pendingToolUses.length > 0) {
                    messages.push({ role: "assistant", content: pendingToolUses });
                    pendingToolUses = [];
                }
            };

            const flushToolResults = () => {
                if (pendingToolResults.length > 0) {
                    protocolConverterUtil.appendAnthropicMessage(messages, "user", pendingToolResults);
                    pendingToolResults = [];
                }
            };

            for (const item of req.input) {
                if ("type" in item && item.type === "function_call") {
                    // 收集 function_call
                    pendingToolUses.push({
                        type: "tool_use",
                        id: item.call_id || `toolu_${Date.now()}`,
                        name: item.name,
                        input: protocolConverterUtil.parseToolArguments(item.arguments),
                    });
                } else if ("type" in item && item.type === "function_call_output") {
                    // 收集 function_call_output
                    pendingToolResults.push({
                        type: "tool_result",
                        tool_use_id: item.call_id,
                        content: this.convertFunctionCallOutput(item.output),
                    });
                } else {
                    // 遇到其他类型，先 flush 之前收集的内容
                    flushToolUses();
                    flushToolResults();
                    this.convertInputItem(item, messages, systemText ? undefined : (t) => { systemText = t; });
                }
            }

            // flush 剩余内容
            flushToolUses();
            flushToolResults();
        }

        const anthropicReq: AnthropicRequest = {
            model: req.model,
            // P1-07：同 OpenAIToAnthropicConverter，缺省取保守值而非 32768
            max_tokens: resolveAnthropicMaxTokens(req.max_output_tokens),
            messages,
            stream: req.stream,
        };

        if (systemText) {
            anthropicReq.system = systemText;
        }

        if (req.temperature !== undefined) {
            anthropicReq.temperature = req.temperature;
        }
        if (req.top_p !== undefined) {
            anthropicReq.top_p = req.top_p;
        }

        // tools（只保留 function 类型的工具，过滤掉 namespace、web_search、image_generation 等）
        if (req.tools && req.tools.length > 0) {
            anthropicReq.tools = req.tools
                .filter((t) => t.type === "function" && !!t.name)
                .map((t) => ({
                    name: t.name!,
                    description: t.description,
                    input_schema: t.parameters || {},
                }));
        }

        // tool_choice
        if (req.tool_choice) {
            if (req.tool_choice === "auto") {
                anthropicReq.tool_choice = { type: "auto" };
            } else if (req.tool_choice === "required") {
                anthropicReq.tool_choice = { type: "any" };
            } else if (req.tool_choice === "none") {
                // 不设置 tool_choice
            } else if (typeof req.tool_choice === "object" && req.tool_choice.type === "function") {
                anthropicReq.tool_choice = { type: "tool", name: req.tool_choice.name };
            }
        }

        const thinkingOutput = thinkingConfigToAnthropic(
            buildThinkingConfigFromOpenAIResponses(req.reasoning),
        );
        if (thinkingOutput) {
            if (thinkingOutput.thinking) {
                anthropicReq.thinking = thinkingOutput.thinking;
            }
            if (thinkingOutput.output_config) {
                anthropicReq.output_config = thinkingOutput.output_config;
            }
        }

        return anthropicReq;
    }

    private convertInputItem(
        item: ResponsesInputItem,
        messages: AnthropicRequest["messages"],
        setSystem?: (text: string) => void,
    ): void {
        if ("type" in item && item.type === "function_call") {
            // function_call → assistant message with tool_use
            const toolUse: AnthropicContentBlock = {
                type: "tool_use",
                id: item.call_id || `toolu_${Date.now()}`,
                name: item.name,
                input: protocolConverterUtil.parseToolArguments(item.arguments),
            };
            messages.push({ role: "assistant", content: [toolUse] });
            return;
        }

        if ("type" in item && item.type === "function_call_output") {
            // function_call_output → user message with tool_result
            const toolResult: AnthropicContentBlock = {
                type: "tool_result",
                tool_use_id: item.call_id,
                content: this.convertFunctionCallOutput(item.output),
            };
            messages.push({ role: "user", content: [toolResult] });
            return;
        }

        if ("type" in item && item.type === "reasoning") {
            // reasoning → skip or convert to thinking block (if present)
            if (item.summary && item.summary.length > 0) {
                const thinkingBlock: AnthropicContentBlock = {
                    type: "thinking",
                    thinking: item.summary.map((s) => s.text).join("\n"),
                    signature: item.encrypted_content || "",
                };
                // 附加到上一个 assistant 消息，或创建新的
                const lastMsg = messages[messages.length - 1];
                if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
                    lastMsg.content.push(thinkingBlock);
                } else {
                    messages.push({ role: "assistant", content: [thinkingBlock] });
                }
            }
            return;
        }

        // message item
        if ("role" in item) {
            const role = item.role;
            const content = item.content;

            if (role === "system" || role === "developer") {
                // system/developer message → system prompt
                const text = protocolConverterUtil.extractResponsesText(content, "Anthropic");
                if (setSystem) {
                    setSystem(text);
                }
                return;
            }

            if (typeof content === "string") {
                protocolConverterUtil.appendAnthropicMessage(messages, role as "user" | "assistant", content);
                return;
            }

            if (Array.isArray(content)) {
                const blocks: AnthropicContentBlock[] = [];
                for (const part of content) {
                    if (part.type === "input_text" || part.type === "output_text") {
                        blocks.push({ type: "text", text: part.text });
                    } else if (part.type === "input_image") {
                        blocks.push(this.convertInputImage(part));
                    } else if (part.type === "input_file") {
                        throw new customError.AppError(
                            "Responses input_file cannot be converted to Anthropic",
                            400,
                        );
                    }
                }
                if (blocks.length > 0) {
                    protocolConverterUtil.appendAnthropicMessage(messages, role as "user" | "assistant", blocks);
                }
            }
        }
    }


    /**
     * Responses function_call_output.output → Anthropic tool_result content。
     * 数组输出支持文本和图片；file_id 图片无法由网关解析，明确报错。
     */
    private convertFunctionCallOutput(
        output: string | ResponsesContentPart[],
    ): string | AnthropicContentBlock[] {
        if (typeof output === "string") {
            return output;
        }

        const blocks: AnthropicContentBlock[] = [];
        for (const part of output) {
            if (part.type === "input_text" || part.type === "output_text") {
                blocks.push({ type: "text", text: part.text });
            } else if (part.type === "input_image") {
                blocks.push(this.convertInputImage(part));
            } else if (part.type === "input_file") {
                throw new customError.AppError(
                    "Responses input_file cannot be converted to Anthropic",
                    400,
                );
            }
        }
        return blocks.length > 0 ? blocks : "";
    }


    /**
     * Responses input_image → Anthropic image block
     */
    private convertInputImage(
        part: { image_url?: string; url?: string; file_id?: string },
    ): AnthropicContentBlock {
        const url = part.image_url || part.url || "";
        if (!url) {
            throw new customError.AppError(
                "Responses input_image with file_id cannot be converted to Anthropic",
                400,
            );
        }

        return { type: "image", source: protocolConverterUtil.anthropicImageSourceFromUrl(url) };
    }


    // ─── 非流式响应转换 ───

    public convertResponse(upstreamRes: AnthropicResponse, requestId?: string): ResponsesNonStreamResponse {
        const output: ResponsesNonStreamResponse["output"] = [];
        const responseId = requestId || upstreamRes.id || `resp_${Date.now()}`;

        for (const block of upstreamRes.content) {
            if (block.type === "text") {
                output.push({
                    type: "message",
                    id: `msg_${responseId}_0`,
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: block.text || "" }],
                });
            } else if (block.type === "tool_use") {
                output.push({
                    type: "function_call",
                    id: `fc_${block.id || Date.now()}`,
                    call_id: block.id || `call_${Date.now()}`,
                    name: block.name || "",
                    arguments: JSON.stringify(block.input || {}),
                    status: "completed",
                });
            } else if (block.type === "thinking") {
                output.push({
                    type: "reasoning",
                    id: `rs_${responseId}_0`,
                    encrypted_content: block.signature || "",
                    summary: block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
                });
            }
        }

        return {
            id: responseId,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            model: upstreamRes.model,
            output,
            usage: {
                input_tokens: upstreamRes.usage?.input_tokens || 0,
                output_tokens: upstreamRes.usage?.output_tokens || 0,
                total_tokens: (upstreamRes.usage?.input_tokens || 0) + (upstreamRes.usage?.output_tokens || 0),
            },
        };
    }

    // ─── 流式响应转换：Anthropic SSE → Responses SSE ───

    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        const eventType = data.type as string || "";
        const out: ProtocolStreamEvent[] = [];

        switch (eventType) {
            case "error": {
                out.push({
                    event: "error",
                    data: JSON.stringify(data),
                });
                break;
            }

            case "message_start": {
                const msg = data.message as AnthropicStreamMessage | undefined;
                if (msg?.model) this.updateModel(msg.model);
                if (msg?.id) {
                    this.responseId = msg.id.startsWith("resp_") ? msg.id : `resp_${msg.id.replace("msg_", "")}`;
                }
                this.inputTokens = msg?.usage?.input_tokens ?? 0;
                this.cacheReadTokens = msg?.usage?.cache_read_input_tokens ?? 0;
                this.seq = 0;
                this.textBuf = "";
                this.messageOpen = false;
                this.contentPartOpen = false;
                this.funcArgsBuf = {};
                this.funcNames = {};
                this.funcCallIds = {};
                this.reasoningActive = false;
                this.reasoningBuf = "";
                this.reasoningSignature = "";
                this.outputTokens = 0;

                // response.created
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
                // response.in_progress
                out.push({
                    data: JSON.stringify({
                        type: "response.in_progress",
                        sequence_number: this.nextSeq(),
                        response: { id: this.responseId, status: "in_progress" },
                    }),
                });
                break;
            }

            case "content_block_start": {
                const block = data.content_block as AnthropicStreamContentBlock | undefined;
                if (!block) break;
                const idx = (data.index as number | undefined) ?? 0;

                if (block.type === "text") {
                    this.inTextBlock = true;
                    this.currentMsgId = this.currentMsgId || `msg_${this.responseId}_0`;

                    if (!this.messageOpen) {
                        out.push({
                            data: JSON.stringify({
                                type: "response.output_item.added",
                                sequence_number: this.nextSeq(),
                                output_index: idx,
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
                                output_index: idx,
                                content_index: 0,
                                part: { type: "output_text", text: "" },
                            }),
                        });
                        this.contentPartOpen = true;
                    }
                } else if (block.type === "tool_use") {
                    this.inFuncBlock = true;
                    this.currentFcId = block.id || "";
                    this.funcCallIds[idx] = this.currentFcId;
                    this.funcNames[idx] = block.name || "";

                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: idx,
                            item: {
                                id: `fc_${this.currentFcId}`,
                                type: "function_call",
                                status: "in_progress",
                                arguments: "",
                                call_id: this.currentFcId,
                                name: block.name || "",
                            },
                        }),
                    });
                    this.funcArgsBuf[idx] = "";
                } else if (block.type === "thinking") {
                    this.reasoningActive = true;
                    this.reasoningIndex = idx;
                    this.reasoningBuf = "";
                    this.reasoningSignature = block.signature || "";
                    this.reasoningItemId = `rs_${this.responseId}_${idx}`;

                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: idx,
                            item: {
                                id: this.reasoningItemId,
                                type: "reasoning",
                                status: "in_progress",
                                encrypted_content: this.reasoningSignature,
                                summary: [],
                            },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_part.added",
                            sequence_number: this.nextSeq(),
                            item_id: this.reasoningItemId,
                            output_index: idx,
                            summary_index: 0,
                            part: { type: "summary_text", text: "" },
                        }),
                    });
                }
                break;
            }

            case "content_block_delta": {
                const delta = data.delta as AnthropicStreamDelta | undefined;
                if (!delta) break;

                if (delta.type === "text_delta") {
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_text.delta",
                            sequence_number: this.nextSeq(),
                            item_id: this.currentMsgId,
                            output_index: 0,
                            content_index: 0,
                            delta: delta.text || "",
                        }),
                    });
                    this.textBuf += delta.text || "";
                } else if (delta.type === "input_json_delta") {
                    const idx = (data.index as number | undefined) ?? 0;
                    this.funcArgsBuf[idx] = (this.funcArgsBuf[idx] || "") + (delta.partial_json || "");
                    out.push({
                        data: JSON.stringify({
                            type: "response.function_call_arguments.delta",
                            sequence_number: this.nextSeq(),
                            item_id: `fc_${this.funcCallIds[idx] || this.currentFcId}`,
                            output_index: idx,
                            delta: delta.partial_json || "",
                        }),
                    });
                } else if (delta.type === "thinking_delta") {
                    if (this.reasoningActive) {
                        this.reasoningBuf += delta.thinking || "";
                        out.push({
                            data: JSON.stringify({
                                type: "response.reasoning_summary_text.delta",
                                sequence_number: this.nextSeq(),
                                item_id: this.reasoningItemId,
                                output_index: this.reasoningIndex,
                                summary_index: 0,
                                delta: delta.thinking || "",
                            }),
                        });
                    }
                } else if (delta.type === "signature_delta") {
                    if (this.reasoningActive) {
                        this.reasoningSignature = delta.signature || this.reasoningSignature;
                    }
                }
                break;
            }

            case "content_block_stop": {
                const idx = (data.index as number | undefined) ?? 0;

                if (this.inTextBlock) {
                    // finalize text
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
                    this.inTextBlock = false;
                } else if (this.inFuncBlock) {
                    const args = this.funcArgsBuf[idx] || "{}";
                    out.push({
                        data: JSON.stringify({
                            type: "response.function_call_arguments.done",
                            sequence_number: this.nextSeq(),
                            item_id: `fc_${this.funcCallIds[idx] || this.currentFcId}`,
                            output_index: idx,
                            arguments: args,
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: idx,
                            item: {
                                id: `fc_${this.funcCallIds[idx] || this.currentFcId}`,
                                type: "function_call",
                                status: "completed",
                                arguments: args,
                                call_id: this.funcCallIds[idx] || this.currentFcId,
                                name: this.funcNames[idx] || "",
                            },
                        }),
                    });
                    this.inFuncBlock = false;
                } else if (this.reasoningActive) {
                    const fullText = this.reasoningBuf;
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_text.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.reasoningItemId,
                            output_index: this.reasoningIndex,
                            summary_index: 0,
                            text: fullText,
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_part.done",
                            sequence_number: this.nextSeq(),
                            item_id: this.reasoningItemId,
                            output_index: this.reasoningIndex,
                            summary_index: 0,
                            part: { type: "summary_text", text: fullText },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.done",
                            sequence_number: this.nextSeq(),
                            output_index: this.reasoningIndex,
                            item: {
                                id: this.reasoningItemId,
                                type: "reasoning",
                                encrypted_content: this.reasoningSignature,
                                summary: fullText ? [{ type: "summary_text", text: fullText }] : [],
                            },
                        }),
                    });
                    this.reasoningActive = false;
                }
                break;
            }

            case "message_delta": {
                const usage = data.usage as AnthropicStreamUsage | undefined;
                if (usage) {
                    this.outputTokens = usage.output_tokens ?? this.outputTokens;
                    this.inputTokens = usage.input_tokens ?? this.inputTokens;
                    if (usage.cache_read_input_tokens !== undefined) {
                        this.cacheReadTokens = usage.cache_read_input_tokens;
                    }
                }
                break;
            }

            case "message_stop": {
                // finalize assistant message if open
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

                // build output array for response.completed
                const outputArr: ResponsesOutputItem[] = [];
                if (this.textBuf) {
                    outputArr.push({
                        id: this.currentMsgId,
                        type: "message",
                        status: "completed",
                        content: [{ type: "output_text", text: this.textBuf }],
                        role: "assistant",
                    });
                }
                // function calls
                const indices = Object.keys(this.funcArgsBuf).map(Number).sort((a, b) => a - b);
                for (const i of indices) {
                    outputArr.push({
                        id: `fc_${this.funcCallIds[i] || this.currentFcId}`,
                        type: "function_call",
                        status: "completed",
                        arguments: this.funcArgsBuf[i] || "{}",
                        call_id: this.funcCallIds[i] || this.currentFcId,
                        name: this.funcNames[i] || "",
                    });
                }

                out.push({
                    data: JSON.stringify({
                        type: "response.completed",
                        sequence_number: this.nextSeq(),
                        response: {
                            id: this.responseId,
                            object: "response",
                            created_at: Math.floor(Date.now() / 1000),
                            status: "completed",
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

                // reset state for next message
                this.textBuf = "";
                this.currentMsgId = "";
                this.currentFcId = "";
                this.funcArgsBuf = {};
                this.funcNames = {};
                this.funcCallIds = {};
                break;
            }
        }

        return out;
    }
}
