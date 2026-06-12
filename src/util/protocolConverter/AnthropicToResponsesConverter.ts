import { BaseConverter } from "./BaseConverter";
import type {
    AnthropicRequest,
    AnthropicResponse,
    AnthropicContentBlock,
    OpenAIMessage,
    ProtocolStreamEvent,
} from "./protocolTypes";
import type {
    ResponsesRequest,
    ResponsesNonStreamResponse,
    ResponsesOutputItem,
    ResponsesInputItem,
} from "./responsesTypes";

const STOP_REASON_MAP: Record<string, string> = {
    completed: "end_turn",
    failed: "end_turn",
};

/**
 * Anthropic → Responses API 转换器
 *
 * 负责：
 * 1. convertRequest:  Anthropic 请求 → Responses 请求
 * 2. convertResponse: Responses 非流式响应 → Anthropic 非流式响应
 * 3. convertStreamEvent: Responses 流式 SSE → Anthropic 流式 SSE
 */
export class AnthropicToResponsesConverter extends BaseConverter {
    private currentToolCallIndex = -1;
    private currentContentBlockIndex = -1;
    private inputTokens = 0;
    private inReasoning = false;

    // ─── 请求转换 ───

    public convertRequest(req: AnthropicRequest): ResponsesRequest {
        const input: ResponsesInputItem[] = [];

        // system → instructions
        let instructions: string | undefined;
        if (req.system) {
            if (typeof req.system === "string") {
                instructions = req.system;
            } else if (Array.isArray(req.system)) {
                instructions = req.system.map((s) => s.text).join("\n\n");
            }
        }

        // messages → input items
        for (const msg of req.messages) {
            if (msg.role === "user") {
                if (typeof msg.content === "string") {
                    input.push({
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: msg.content }],
                    });
                } else if (Array.isArray(msg.content)) {
                    // 先收集普通内容
                    const textParts: string[] = [];
                    const imageParts: ResponsesInputItem[] = [];

                    for (const block of msg.content) {
                        if (block.type === "text") {
                            textParts.push(block.text || "");
                        } else if (block.type === "image") {
                            const src = block.source;
                            if (src?.type === "base64" && src.data) {
                                imageParts.push({
                                    type: "message",
                                    role: "user",
                                    content: [{
                                        type: "input_image",
                                        image_url: `data:${src.media_type || "image/png"};base64,${src.data}`,
                                    }],
                                });
                            } else if (src?.url) {
                                imageParts.push({
                                    type: "message",
                                    role: "user",
                                    content: [{ type: "input_image", image_url: src.url }],
                                });
                            }
                        } else if (block.type === "tool_result") {
                            // tool_result → function_call_output
                            const content = typeof block.content === "string"
                                ? block.content
                                : JSON.stringify(block.content);
                            input.push({
                                type: "function_call_output",
                                call_id: block.tool_use_id || "",
                                output: content,
                            });
                        }
                    }

                    if (textParts.length > 0) {
                        input.push({
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text: textParts.join("\n") }],
                        });
                    }
                    for (const img of imageParts) {
                        input.push(img);
                    }
                }
            } else if (msg.role === "assistant") {
                if (typeof msg.content === "string") {
                    input.push({
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: msg.content }],
                    });
                } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block.type === "text") {
                            input.push({
                                type: "message",
                                role: "assistant",
                                content: [{ type: "output_text", text: block.text || "" }],
                            });
                        } else if (block.type === "thinking") {
                            input.push({
                                type: "reasoning",
                                summary: block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
                                encrypted_content: block.signature || "",
                            });
                        } else if (block.type === "tool_use") {
                            input.push({
                                type: "function_call",
                                call_id: block.id || `call_${Date.now()}`,
                                name: block.name || "",
                                arguments: JSON.stringify(block.input || {}),
                            });
                        }
                    }
                }
            }
        }

        const responsesReq: ResponsesRequest = {
            model: req.model,
            input,
            stream: req.stream,
            max_output_tokens: req.max_tokens,
        };

        if (instructions) {
            responsesReq.instructions = instructions;
        }

        if (req.temperature !== undefined) {
            responsesReq.temperature = req.temperature;
        }
        if (req.top_p !== undefined) {
            responsesReq.top_p = req.top_p;
        }

        // tools
        if (req.tools && req.tools.length > 0) {
            responsesReq.tools = req.tools.map((t) => ({
                type: "function",
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
            }));
        }

        // tool_choice
        if (req.tool_choice) {
            switch (req.tool_choice.type) {
                case "auto":
                    responsesReq.tool_choice = "auto";
                    break;
                case "any":
                    responsesReq.tool_choice = "required";
                    break;
                case "tool":
                    responsesReq.tool_choice = { type: "function", name: req.tool_choice.name || "" };
                    break;
            }
        }

        // thinking → reasoning
        if (req.thinking?.type === "enabled") {
            responsesReq.reasoning = { effort: "high" };
        }

        return responsesReq;
    }

    // ─── 非流式响应转换 ───

    public convertResponse(upstreamRes: ResponsesNonStreamResponse, requestId?: string): AnthropicResponse {
        const content: AnthropicContentBlock[] = [];

        for (const item of upstreamRes.output) {
            if (item.type === "message") {
                for (const part of item.content) {
                    if (part.type === "output_text") {
                        content.push({ type: "text", text: part.text });
                    }
                }
            } else if (item.type === "function_call") {
                content.push({
                    type: "tool_use",
                    id: item.call_id || item.id,
                    name: item.name,
                    input: this.safeParseArgs(item.arguments),
                });
            } else if (item.type === "reasoning") {
                const thinkingText = item.summary?.map((s) => s.text).join("\n") || "";
                if (thinkingText) {
                    content.push({
                        type: "thinking",
                        thinking: thinkingText,
                        signature: item.encrypted_content || "",
                    });
                }
            }
        }

        // Determine stop_reason
        let stopReason: AnthropicResponse["stop_reason"] = "end_turn";
        const hasToolUse = content.some((b) => b.type === "tool_use");
        if (hasToolUse) stopReason = "tool_use";

        const finalId = requestId || upstreamRes.id;

        return {
            id: finalId.startsWith("msg_") ? finalId : `msg_${finalId.replace("resp_", "")}`,
            type: "message",
            role: "assistant",
            content,
            model: upstreamRes.model,
            stop_reason: stopReason,
            usage: {
                input_tokens: upstreamRes.usage?.input_tokens || 0,
                output_tokens: upstreamRes.usage?.output_tokens || 0,
            },
        };
    }

    // ─── 流式响应转换：Responses SSE → Anthropic SSE ───

    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        const eventType = data.type as string || "";
        const out: ProtocolStreamEvent[] = [];

        switch (eventType) {
            case "response.created": {
                const resp = (data as any).response;
                this.responseId = resp?.id || this.responseId;
                this.inputTokens = resp?.usage?.input_tokens ?? 0;
                this.currentToolCallIndex = -1;
                this.currentContentBlockIndex = -1;
                this.inReasoning = false;

                // message_start
                out.push({
                    data: JSON.stringify({
                        type: "message_start",
                        message: {
                            id: this.responseId.startsWith("msg_") ? this.responseId : `msg_${this.responseId.replace("resp_", "")}`,
                            type: "message",
                            role: "assistant",
                            content: [],
                            model: this.requestModel,
                            stop_reason: null,
                            usage: { input_tokens: this.inputTokens, output_tokens: 0 },
                        },
                    }),
                    event: "message_start",
                });
                break;
            }

            case "response.output_item.added": {
                const item = (data as any).item;
                if (!item) break;

                if (item.type === "message") {
                    // text block start
                    this.currentContentBlockIndex++;
                    out.push({
                        data: JSON.stringify({
                            type: "content_block_start",
                            index: this.currentContentBlockIndex,
                            content_block: { type: "text", text: "" },
                        }),
                        event: "content_block_start",
                    });
                } else if (item.type === "function_call") {
                    this.currentContentBlockIndex++;
                    this.currentToolCallIndex++;
                    out.push({
                        data: JSON.stringify({
                            type: "content_block_start",
                            index: this.currentContentBlockIndex,
                            content_block: {
                                type: "tool_use",
                                id: item.call_id || item.id,
                                name: item.name,
                                input: {},
                            },
                        }),
                        event: "content_block_start",
                    });
                } else if (item.type === "reasoning") {
                    this.currentContentBlockIndex++;
                    this.inReasoning = true;
                    out.push({
                        data: JSON.stringify({
                            type: "content_block_start",
                            index: this.currentContentBlockIndex,
                            content_block: {
                                type: "thinking",
                                thinking: "",
                            },
                        }),
                        event: "content_block_start",
                    });
                }
                break;
            }

            case "response.output_text.delta": {
                out.push({
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: this.currentContentBlockIndex,
                        delta: { type: "text_delta", text: (data as any).delta || "" },
                    }),
                    event: "content_block_delta",
                });
                break;
            }

            case "response.function_call_arguments.delta": {
                out.push({
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: this.currentContentBlockIndex,
                        delta: { type: "input_json_delta", partial_json: (data as any).delta || "" },
                    }),
                    event: "content_block_delta",
                });
                break;
            }

            case "response.reasoning_summary_text.delta": {
                out.push({
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: this.currentContentBlockIndex,
                        delta: { type: "thinking_delta", thinking: (data as any).delta || "" },
                    }),
                    event: "content_block_delta",
                });
                break;
            }

            case "response.output_text.done":
            case "response.content_part.done":
                // 不需要特别处理，content_block_stop 会收尾
                break;

            case "response.function_call_arguments.done": {
                // function call done → content_block_stop
                out.push({
                    data: JSON.stringify({
                        type: "content_block_stop",
                        index: this.currentContentBlockIndex,
                    }),
                    event: "content_block_stop",
                });
                break;
            }

            case "response.output_item.done": {
                const item = (data as any).item;
                if (!item) break;

                if (item.type === "message") {
                    out.push({
                        data: JSON.stringify({
                            type: "content_block_stop",
                            index: this.currentContentBlockIndex,
                        }),
                        event: "content_block_stop",
                    });
                } else if (item.type === "function_call") {
                    // 已经在 arguments.done 里处理了 content_block_stop
                } else if (item.type === "reasoning") {
                    out.push({
                        data: JSON.stringify({
                            type: "content_block_stop",
                            index: this.currentContentBlockIndex,
                        }),
                        event: "content_block_stop",
                    });
                    this.inReasoning = false;
                }
                break;
            }

            case "response.completed": {
                const resp = (data as any).response;
                const outputTokens = resp?.usage?.output_tokens || 0;
                const inputTokensVal = resp?.usage?.input_tokens || this.inputTokens;

                // 判断 stop_reason
                let stopReason = "end_turn";
                if (resp?.output) {
                    const hasToolUse = resp.output.some((o: any) => o.type === "function_call");
                    if (hasToolUse) stopReason = "tool_use";
                }

                // message_delta + message_stop
                out.push({
                    data: JSON.stringify({
                        type: "message_delta",
                        delta: { stop_reason: stopReason },
                        usage: { output_tokens: outputTokens, input_tokens: inputTokensVal },
                    }),
                    event: "message_delta",
                });
                out.push({
                    data: JSON.stringify({ type: "message_stop" }),
                    event: "message_stop",
                });
                break;
            }
        }

        return out;
    }

    private safeParseArgs(args: string): Record<string, unknown> {
        try {
            const parsed = JSON.parse(args);
            return typeof parsed === "object" && parsed !== null ? parsed : {};
        } catch {
            return {};
        }
    }
}
