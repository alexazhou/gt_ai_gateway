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
import protocolConverterUtil, { type RawAnthropicUsage } from "./protocolConverterUtil";

type AnthropicToResponsesOutputItem =
    | { kind: "message"; outputIndex: number; id: string; text: string; closed: boolean }
    | { kind: "reasoning"; outputIndex: number; id: string; thinking: string; signature: string; closed: boolean }
    | { kind: "function_call"; outputIndex: number; id: string; callId: string; name: string; args: string; closed: boolean };

/**
 * Responses API → Anthropic 转换器
 *
 * 负责：
 * 1. convertRequest:  Responses 请求 → Anthropic 请求
 * 2. convertResponse: Anthropic 非流式响应 → Responses 非流式响应
 * 3. convertStreamEvent: Anthropic 流式 SSE → Responses 流式 SSE
 */
export class ResponsesToAnthropicConverter extends BaseConverter {
    private outputItems: AnthropicToResponsesOutputItem[] = [];
    private blockToItem = new Map<number, AnthropicToResponsesOutputItem>();
    private rawUsage: RawAnthropicUsage = {};
    private stopReason: string | null = null;

    // ─── 请求转换 ───

    public convertRequest(req: ResponsesRequest): AnthropicRequest {
        const messages: AnthropicRequest["messages"] = [];
        const systemParts: string[] = [];

        // instructions → system
        if (req.instructions) {
            systemParts.push(req.instructions);
        }

        if (typeof req.input === "string") {
            messages.push({ role: "user", content: req.input });
        } else {
            // 只合并同一轮内连续的 function_call 或连续的 function_call_output，跨阶段时立即 flush 保留轮次
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
                    flushToolResults();
                    // 收集同一轮连续的 function_call
                    pendingToolUses.push({
                        type: "tool_use",
                        id: item.call_id || `toolu_${Date.now()}`,
                        name: item.name,
                        input: protocolConverterUtil.parseToolArguments(item.arguments),
                    });
                } else if ("type" in item && item.type === "function_call_output") {
                    flushToolUses();
                    // 收集同一轮连续的 function_call_output
                    pendingToolResults.push({
                        type: "tool_result",
                        tool_use_id: item.call_id,
                        content: this.convertFunctionCallOutput(item.output),
                    });
                } else {
                    // 遇到其他类型，先 flush 之前收集的内容
                    flushToolUses();
                    flushToolResults();
                    this.convertInputItem(item, messages, (t) => {
                        if (t) systemParts.push(t);
                    }, req.model);
                }
            }

            // flush 剩余内容
            flushToolUses();
            flushToolResults();
        }

        const rawMaxTokens = req.max_output_tokens;
        if (rawMaxTokens !== undefined) {
            if (typeof rawMaxTokens !== "number" || !Number.isFinite(rawMaxTokens) || rawMaxTokens <= 0) {
                throw new customError.AppError("max_output_tokens must be a positive number", 400);
            }
        }

        const anthropicReq: AnthropicRequest = {
            model: req.model,
            max_tokens: rawMaxTokens ?? 32768,
            messages,
            stream: req.stream,
        };

        if (systemParts.length > 0) {
            anthropicReq.system = systemParts.join("\n\n");
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
                anthropicReq.tool_choice = { type: "none" };
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
        targetModel?: string,
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
            let signature = "";
            let thinkingText = item.summary?.map((s) => s.text).join("\n") || "";
            if (item.encrypted_content) {
                const unsealed = protocolConverterUtil.unsealThinkingSignature(
                    item.encrypted_content,
                    "anthropic",
                    targetModel,
                );
                if (!unsealed) {
                    throw new customError.AppError(
                        "Incompatible or unverified reasoning encrypted_content cannot be converted to Anthropic thinking signature",
                        400,
                    );
                }
                signature = unsealed.signature;
                if (unsealed.thinking !== undefined) {
                    thinkingText = unsealed.thinking;
                }
            }
            if (signature && thinkingText) {
                const thinkingBlock: AnthropicContentBlock = {
                    type: "thinking",
                    thinking: thinkingText,
                    signature,
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
            const itemIndex = output.length;
            if (block.type === "text") {
                output.push({
                    type: "message",
                    id: `msg_${responseId}_${itemIndex}`,
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: block.text || "" }],
                });
            } else if (block.type === "tool_use") {
                output.push({
                    type: "function_call",
                    id: `fc_${block.id || `${responseId}_${itemIndex}`}`,
                    call_id: block.id || `call_${responseId}_${itemIndex}`,
                    name: block.name || "",
                    arguments: JSON.stringify(block.input || {}),
                    status: "completed",
                });
            } else if (block.type === "thinking") {
                output.push({
                    type: "reasoning",
                    id: `rs_${responseId}_${itemIndex}`,
                    encrypted_content: protocolConverterUtil.sealThinkingSignature(
                        "anthropic",
                        block.signature || "",
                        { model: upstreamRes.model, thinking: block.thinking },
                    ),
                    summary: block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
                });
            }
        }

        return {
            id: responseId,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: upstreamRes.stop_reason === "max_tokens" ? "incomplete" : "completed",
            ...(upstreamRes.stop_reason === "max_tokens"
                ? { incomplete_details: { reason: "max_output_tokens" } }
                : {}),
            model: upstreamRes.model,
            output,
            usage: protocolConverterUtil.anthropicUsageToResponses(
                protocolConverterUtil.mergeAnthropicUsage({}, upstreamRes.usage),
            ),
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
                this.rawUsage = {};
                protocolConverterUtil.mergeAnthropicUsage(this.rawUsage, msg?.usage);
                this.stopReason = null;
                this.seq = 0;
                this.outputItems = [];
                this.blockToItem.clear();

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
                const outputIndex = this.outputItems.length;

                if (block.type === "text") {
                    const item: AnthropicToResponsesOutputItem = {
                        kind: "message",
                        outputIndex,
                        id: `msg_${this.responseId}_${outputIndex}`,
                        text: "",
                        closed: false,
                    };
                    this.outputItems.push(item);
                    this.blockToItem.set(idx, item);

                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: outputIndex,
                            item: {
                                id: item.id,
                                type: "message",
                                status: "in_progress",
                                content: [],
                                role: "assistant",
                            },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.content_part.added",
                            sequence_number: this.nextSeq(),
                            item_id: item.id,
                            output_index: outputIndex,
                            content_index: 0,
                            part: { type: "output_text", text: "" },
                        }),
                    });
                } else if (block.type === "tool_use") {
                    const callId = block.id || `call_${this.responseId}_${outputIndex}`;
                    const item: AnthropicToResponsesOutputItem = {
                        kind: "function_call",
                        outputIndex,
                        id: `fc_${callId}`,
                        callId,
                        name: block.name || "",
                        args: "",
                        closed: false,
                    };
                    this.outputItems.push(item);
                    this.blockToItem.set(idx, item);

                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: outputIndex,
                            item: {
                                id: item.id,
                                type: "function_call",
                                status: "in_progress",
                                arguments: "",
                                call_id: item.callId,
                                name: item.name,
                            },
                        }),
                    });
                } else if (block.type === "thinking") {
                    const item: AnthropicToResponsesOutputItem = {
                        kind: "reasoning",
                        outputIndex,
                        id: `rs_${this.responseId}_${outputIndex}`,
                        thinking: "",
                        signature: block.signature || "",
                        closed: false,
                    };
                    this.outputItems.push(item);
                    this.blockToItem.set(idx, item);

                    out.push({
                        data: JSON.stringify({
                            type: "response.output_item.added",
                            sequence_number: this.nextSeq(),
                            output_index: outputIndex,
                            item: {
                                id: item.id,
                                type: "reasoning",
                                status: "in_progress",
                                encrypted_content: item.signature,
                                summary: [],
                            },
                        }),
                    });
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_part.added",
                            sequence_number: this.nextSeq(),
                            item_id: item.id,
                            output_index: outputIndex,
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
                const idx = (data.index as number | undefined) ?? 0;
                const item = this.blockToItem.get(idx);
                if (!item) break;

                if (delta.type === "text_delta" && item.kind === "message") {
                    item.text += delta.text || "";
                    out.push({
                        data: JSON.stringify({
                            type: "response.output_text.delta",
                            sequence_number: this.nextSeq(),
                            item_id: item.id,
                            output_index: item.outputIndex,
                            content_index: 0,
                            delta: delta.text || "",
                        }),
                    });
                } else if (delta.type === "input_json_delta" && item.kind === "function_call") {
                    item.args += delta.partial_json || "";
                    out.push({
                        data: JSON.stringify({
                            type: "response.function_call_arguments.delta",
                            sequence_number: this.nextSeq(),
                            item_id: item.id,
                            output_index: item.outputIndex,
                            delta: delta.partial_json || "",
                        }),
                    });
                } else if (delta.type === "thinking_delta" && item.kind === "reasoning") {
                    item.thinking += delta.thinking || "";
                    out.push({
                        data: JSON.stringify({
                            type: "response.reasoning_summary_text.delta",
                            sequence_number: this.nextSeq(),
                            item_id: item.id,
                            output_index: item.outputIndex,
                            summary_index: 0,
                            delta: delta.thinking || "",
                        }),
                    });
                } else if (delta.type === "signature_delta" && item.kind === "reasoning") {
                    item.signature = delta.signature || item.signature;
                }
                break;
            }

            case "content_block_stop": {
                const idx = (data.index as number | undefined) ?? 0;
                const item = this.blockToItem.get(idx);
                if (item) {
                    this.closeOutputItem(item, out);
                }
                break;
            }

            case "message_delta": {
                const delta = data.delta as AnthropicStreamDelta | undefined;
                if (delta?.stop_reason !== undefined) {
                    this.stopReason = delta.stop_reason;
                }
                const usage = data.usage as AnthropicStreamUsage | undefined;
                if (usage) {
                    protocolConverterUtil.mergeAnthropicUsage(this.rawUsage, usage);
                }
                break;
            }

            case "message_stop": {
                for (const item of this.outputItems) {
                    this.closeOutputItem(item, out);
                }

                const outputArr: ResponsesOutputItem[] = this.outputItems.map((item) => this.toFinalOutputItem(item));

                const isIncomplete = this.stopReason === "max_tokens";
                out.push({
                    data: JSON.stringify({
                        type: isIncomplete ? "response.incomplete" : "response.completed",
                        sequence_number: this.nextSeq(),
                        response: {
                            id: this.responseId,
                            object: "response",
                            created_at: Math.floor(Date.now() / 1000),
                            status: isIncomplete ? "incomplete" : "completed",
                            ...(isIncomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
                            model: this.requestModel,
                            output: outputArr,
                            usage: protocolConverterUtil.anthropicUsageToResponses(this.rawUsage),
                        },
                    }),
                });

                this.outputItems = [];
                this.blockToItem.clear();
                break;
            }
        }

        return out;
    }


    private toFinalOutputItem(item: AnthropicToResponsesOutputItem): ResponsesOutputItem {
        if (item.kind === "message") {
            return {
                id: item.id,
                type: "message",
                status: "completed",
                content: [{ type: "output_text", text: item.text }],
                role: "assistant",
            };
        }
        if (item.kind === "reasoning") {
            return {
                id: item.id,
                type: "reasoning",
                encrypted_content: protocolConverterUtil.sealThinkingSignature(
                    "anthropic",
                    item.signature,
                    { model: this.requestModel, thinking: item.thinking },
                ),
                summary: item.thinking ? [{ type: "summary_text", text: item.thinking }] : [],
            };
        }
        return {
            id: item.id,
            type: "function_call",
            status: "completed",
            arguments: item.args || "{}",
            call_id: item.callId,
            name: item.name,
        };
    }


    private closeOutputItem(item: AnthropicToResponsesOutputItem, out: ProtocolStreamEvent[]): void {
        if (item.closed) return;
        item.closed = true;

        if (item.kind === "message") {
            out.push({
                data: JSON.stringify({
                    type: "response.output_text.done",
                    sequence_number: this.nextSeq(),
                    item_id: item.id,
                    output_index: item.outputIndex,
                    content_index: 0,
                    text: item.text,
                }),
            });
            out.push({
                data: JSON.stringify({
                    type: "response.content_part.done",
                    sequence_number: this.nextSeq(),
                    item_id: item.id,
                    output_index: item.outputIndex,
                    content_index: 0,
                    part: { type: "output_text", text: item.text },
                }),
            });
            out.push({
                data: JSON.stringify({
                    type: "response.output_item.done",
                    sequence_number: this.nextSeq(),
                    output_index: item.outputIndex,
                    item: this.toFinalOutputItem(item),
                }),
            });
        } else if (item.kind === "function_call") {
            const args = item.args || "{}";
            out.push({
                data: JSON.stringify({
                    type: "response.function_call_arguments.done",
                    sequence_number: this.nextSeq(),
                    item_id: item.id,
                    output_index: item.outputIndex,
                    arguments: args,
                }),
            });
            out.push({
                data: JSON.stringify({
                    type: "response.output_item.done",
                    sequence_number: this.nextSeq(),
                    output_index: item.outputIndex,
                    item: this.toFinalOutputItem(item),
                }),
            });
        } else if (item.kind === "reasoning") {
            out.push({
                data: JSON.stringify({
                    type: "response.reasoning_summary_text.done",
                    sequence_number: this.nextSeq(),
                    item_id: item.id,
                    output_index: item.outputIndex,
                    summary_index: 0,
                    text: item.thinking,
                }),
            });
            out.push({
                data: JSON.stringify({
                    type: "response.reasoning_summary_part.done",
                    sequence_number: this.nextSeq(),
                    item_id: item.id,
                    output_index: item.outputIndex,
                    summary_index: 0,
                    part: { type: "summary_text", text: item.thinking },
                }),
            });
            out.push({
                data: JSON.stringify({
                    type: "response.output_item.done",
                    sequence_number: this.nextSeq(),
                    output_index: item.outputIndex,
                    item: this.toFinalOutputItem(item),
                }),
            });
        }
    }
}
