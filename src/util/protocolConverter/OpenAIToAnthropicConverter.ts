import { BaseConverter } from "./BaseConverter";
import type {
    AnthropicRequest,
    OpenAIRequest,
    AnthropicResponse,
    OpenAIResponse,
    AnthropicContentBlock,
    AnthropicTool,
    AnthropicSSEEvent,
    OpenAIChunk,
    ProtocolStreamEvent,
} from "./protocolTypes";

const OPENAI_TO_ANTHROPIC_STOP_REASON: Record<string, string> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
};

export class OpenAIToAnthropicConverter extends BaseConverter {
    private sentFirstChunk = false;
    private hasYieldedThinking = false;
    private currentToolCallId = "";
    private isFirstChunk = true;
    private pendingStopReason: string | null = null;

    public convertRequest(clientReq: OpenAIRequest): AnthropicRequest {
        let systemPrompt: string | undefined;
        const messages: AnthropicRequest["messages"] = [];

        for (const msg of clientReq.messages) {
            if (msg.role === "system") {
                systemPrompt = (systemPrompt ? systemPrompt + "\n\n" : "") + (msg.content || "");
                continue;
            }

            if (msg.role === "tool") {
                messages.push({
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: msg.tool_call_id || "",
                            content: msg.content || "",
                        },
                    ],
                });
                continue;
            }

            if (msg.role === "assistant" && msg.tool_calls) {
                const contentBlocks: AnthropicContentBlock[] = [];

                if (msg.content) {
                    contentBlocks.push({ type: "text", text: msg.content });
                }

                for (const tc of msg.tool_calls) {
                    let inputObj: Record<string, unknown> = {};
                    try {
                        inputObj = JSON.parse(tc.function.arguments);
                    } catch {
                        inputObj = { raw: tc.function.arguments };
                    }
                    contentBlocks.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: inputObj,
                    });
                }

                messages.push({ role: "assistant", content: contentBlocks });
                continue;
            }

            if (msg.role === "user" || msg.role === "assistant") {
                messages.push({
                    role: msg.role,
                    content: msg.content || "",
                });
            }
        }

        const anthropicTools: AnthropicTool[] | undefined = clientReq.tools?.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters || { type: "object", properties: {} },
        }));

        let anthropicToolChoice: AnthropicRequest["tool_choice"] = undefined;
        if (clientReq.tool_choice) {
            if (typeof clientReq.tool_choice === "string") {
                switch (clientReq.tool_choice) {
                    case "auto":
                        anthropicToolChoice = { type: "auto" };
                        break;
                    case "required":
                        anthropicToolChoice = { type: "any" };
                        break;
                    case "none":
                        break;
                }
            } else if (typeof clientReq.tool_choice === "object") {
                anthropicToolChoice = {
                    type: "tool",
                    name: clientReq.tool_choice.function.name,
                };
            }
        }

        const anthropicReq: AnthropicRequest = {
            model: clientReq.model,
            max_tokens: clientReq.max_tokens || clientReq.max_completion_tokens || 4096,
            messages,
            stream: clientReq.stream,
            temperature: clientReq.temperature,
            top_p: clientReq.top_p,
            stop_sequences: typeof clientReq.stop === "string" ? [clientReq.stop] : clientReq.stop,
        };

        if (systemPrompt) {
            anthropicReq.system = systemPrompt;
        }
        if (anthropicTools) {
            anthropicReq.tools = anthropicTools;
        }
        if (anthropicToolChoice) {
            anthropicReq.tool_choice = anthropicToolChoice;
        }

        return anthropicReq;
    }

    public convertResponse(upstreamRes: OpenAIResponse, requestId?: string): AnthropicResponse {
        const message = upstreamRes.choices[0]?.message;
        const contentBlocks: AnthropicContentBlock[] = [];

        if (message?.reasoning_content) {
            contentBlocks.push({
                type: "thinking",
                thinking: message.reasoning_content,
            });
        }

        if (message?.content) {
            contentBlocks.push({ type: "text", text: message.content });
        }

        if (message?.tool_calls) {
            for (const tc of message.tool_calls) {
                let inputObj: Record<string, unknown> = {};
                try {
                    inputObj = JSON.parse(tc.function.arguments);
                } catch {
                    inputObj = { raw: tc.function.arguments };
                }
                contentBlocks.push({
                    type: "tool_use",
                    id: tc.id,
                    name: tc.function.name,
                    input: inputObj,
                });
            }
        }

        if (contentBlocks.length === 0) {
            contentBlocks.push({ type: "text", text: "" });
        }

        const stopReason = OPENAI_TO_ANTHROPIC_STOP_REASON[upstreamRes.choices[0]?.finish_reason || "stop"] || "end_turn";
        const finalId = requestId || upstreamRes.id;

        return {
            id: finalId.startsWith("msg_") ? finalId : `msg_${finalId.replace("chatcmpl-", "")}`,
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: upstreamRes.model,
            stop_reason: stopReason as AnthropicResponse["stop_reason"],
            usage: {
                input_tokens: upstreamRes.usage?.prompt_tokens || 0,
                output_tokens: upstreamRes.usage?.completion_tokens || 0,
            },
        };
    }

    protected override handleDoneEvent(): ProtocolStreamEvent[] {
        if (this.pendingStopReason !== null) {
            const events: AnthropicSSEEvent[] = [
                {
                    event: "message_delta",
                    data: JSON.stringify({
                        type: "message_delta",
                        delta: { stop_reason: this.pendingStopReason, stop_sequence: null },
                        usage: { input_tokens: 0, output_tokens: 0 },
                    }),
                },
                {
                    event: "message_stop",
                    data: JSON.stringify({ type: "message_stop" }),
                },
            ];
            this.pendingStopReason = null;
            return events;
        }
        return [];
    }

    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {

        const events: AnthropicSSEEvent[] = [];
        const chunk = data as OpenAIChunk;

        if (this.isFirstChunk) {
            this.isFirstChunk = false;
            if (chunk.model) this.updateModel(chunk.model);
            if (chunk.id) {
                this.updateResponseId(chunk.id.startsWith("msg_") ? chunk.id : `msg_${chunk.id.replace("chatcmpl-", "")}`);
            }

            events.push({
                event: "message_start",
                data: JSON.stringify({
                    type: "message_start",
                    message: {
                        id: this.responseId,
                        type: "message",
                        role: "assistant",
                        model: this.requestModel,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                    },
                }),
            });
        }

        if (chunk.choices && chunk.choices.length > 0) {
            const delta = chunk.choices[0].delta;

            if (delta.reasoning_content) {
                if (!this.hasYieldedThinking) {
                    this.hasYieldedThinking = true;
                    events.push({
                        event: "content_block_start",
                        data: JSON.stringify({
                            type: "content_block_start",
                            index: this.contentBlockIndex,
                            content_block: { type: "thinking", thinking: "" },
                        }),
                    });
                }
                events.push({
                    event: "content_block_delta",
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: this.contentBlockIndex,
                        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
                    }),
                });
            }

            if (delta.content) {
                if (!this.sentFirstChunk) {
                    if (this.hasYieldedThinking) {
                        events.push({
                            event: "content_block_stop",
                            data: JSON.stringify({
                                type: "content_block_stop",
                                index: this.contentBlockIndex,
                            }),
                        });
                        this.contentBlockIndex++;
                    }

                    this.sentFirstChunk = true;
                    events.push({
                        event: "content_block_start",
                        data: JSON.stringify({
                            type: "content_block_start",
                            index: this.contentBlockIndex,
                            content_block: { type: "text", text: "" },
                        }),
                    });
                }

                events.push({
                    event: "content_block_delta",
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: this.contentBlockIndex,
                        delta: { type: "text_delta", text: delta.content },
                    }),
                });
            }

            if (delta.tool_calls && delta.tool_calls.length > 0) {
                for (const tc of delta.tool_calls) {
                    if (tc.id || tc.function?.name) {
                        if (this.sentFirstChunk || this.hasYieldedThinking) {
                            events.push({
                                event: "content_block_stop",
                                data: JSON.stringify({
                                    type: "content_block_stop",
                                    index: this.contentBlockIndex,
                                }),
                            });
                            this.contentBlockIndex++;
                            this.sentFirstChunk = false;
                            this.hasYieldedThinking = false;
                        }

                        this.currentToolCallId = tc.id || `call_${Date.now()}`;
                        events.push({
                            event: "content_block_start",
                            data: JSON.stringify({
                                type: "content_block_start",
                                index: this.contentBlockIndex,
                                content_block: {
                                    type: "tool_use",
                                    id: this.currentToolCallId,
                                    name: tc.function?.name || "",
                                    input: {},
                                },
                            }),
                        });
                    }

                    if (tc.function?.arguments) {
                        events.push({
                            event: "content_block_delta",
                            data: JSON.stringify({
                                type: "content_block_delta",
                                index: this.contentBlockIndex,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: tc.function.arguments,
                                },
                            }),
                        });
                    }
                }
            }

            if (chunk.choices[0].finish_reason) {
                if (this.sentFirstChunk || this.currentToolCallId || this.hasYieldedThinking) {
                    events.push({
                        event: "content_block_stop",
                        data: JSON.stringify({
                            type: "content_block_stop",
                            index: this.contentBlockIndex,
                        }),
                    });
                }

                const stopReason = OPENAI_TO_ANTHROPIC_STOP_REASON[chunk.choices[0].finish_reason] || "end_turn";

                if (chunk.usage) {
                    // usage 在同一帧里，直接发出
                    const cachedTokens = (chunk.usage as any).prompt_tokens_details?.cached_tokens;
                    events.push({
                        event: "message_delta",
                        data: JSON.stringify({
                            type: "message_delta",
                            delta: { stop_reason: stopReason, stop_sequence: null },
                            usage: {
                                input_tokens: (chunk.usage.prompt_tokens || 0) - (cachedTokens || 0),
                                output_tokens: chunk.usage.completion_tokens || 0,
                                ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
                            },
                        }),
                    });
                    events.push({
                        event: "message_stop",
                        data: JSON.stringify({ type: "message_stop" }),
                    });
                } else {
                    // usage 在后续独立帧（stream_options），先缓存 stop reason
                    this.pendingStopReason = stopReason;
                }
            }
        }

        // 处理 OpenAI stream_options 的独立 usage 帧（choices 为空，只含 usage）
        if ((!chunk.choices || chunk.choices.length === 0) && chunk.usage && this.pendingStopReason !== null) {
            const cachedTokens = (chunk.usage as any).prompt_tokens_details?.cached_tokens;
            events.push({
                event: "message_delta",
                data: JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: this.pendingStopReason, stop_sequence: null },
                    usage: {
                        input_tokens: (chunk.usage.prompt_tokens || 0) - (cachedTokens || 0),
                        output_tokens: chunk.usage.completion_tokens || 0,
                        ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
                    },
                }),
            });
            events.push({
                event: "message_stop",
                data: JSON.stringify({ type: "message_stop" }),
            });
            this.pendingStopReason = null;
        }

        return events;
    }
}
