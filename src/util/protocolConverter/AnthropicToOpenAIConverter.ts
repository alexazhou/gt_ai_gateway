import { BaseConverter } from "./BaseConverter";
import type {
    AnthropicRequest,
    OpenAIRequest,
    AnthropicResponse,
    OpenAIResponse,
    OpenAIMessage,
    OpenAITool,
    AnthropicContentBlock,
    AnthropicSSEEvent,
    OpenAIChunk,
    ProtocolStreamEvent,
} from "./protocolTypes";
import {
    buildThinkingConfigFromAnthropic,
    thinkingConfigToOpenAI,
} from "./thinkingConfig";

const OPENAI_TO_ANTHROPIC_STOP_REASON: Record<string, string> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
};

export class AnthropicToOpenAIConverter extends BaseConverter {
    private sentFirstChunk = false;
    private hasYieldedThinking = false;
    private currentToolCallId = "";
    private isFirstChunk = true;
    private pendingStopReason: string | null = null;
    /**
     * 累积的最终 usage(openai 可能把 usage 拆到多个 chunk,缓存在末尾的 usage-only chunk 才出现,
     * 因此只有等到 [DONE] 才能拿到完整 usage)。统一在 handleDoneEvent 时聚合并发出。
     */
    private pendingUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null = null;

    /**
     * 累积一次 openai usage 到 pendingUsage,后到的 chunk 字段优先。
     * input_tokens 归一化为非缓存部分 = prompt_tokens - cached_tokens。
     */
    private accumulateUsage(chunk: OpenAIChunk): void {
        const usage = chunk.usage as (Record<string, unknown> & {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
        }) | undefined;
        if (!usage) return;

        const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
        if (!this.pendingUsage) {
            this.pendingUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
        }
        if (usage.prompt_tokens !== undefined) {
            this.pendingUsage.inputTokens = Math.max(0, (usage.prompt_tokens || 0) - (cachedTokens || 0));
        }
        if (usage.completion_tokens !== undefined) {
            this.pendingUsage.outputTokens = usage.completion_tokens || 0;
        }
        if (cachedTokens !== undefined) {
            this.pendingUsage.cacheReadTokens = cachedTokens;
        }
    }



    public convertRequest(clientReq: AnthropicRequest): OpenAIRequest {
        const messages: OpenAIRequest["messages"] = [];

        if (clientReq.system) {
            let systemContent = "";
            if (typeof clientReq.system === "string") {
                systemContent = clientReq.system;
            } else if (Array.isArray(clientReq.system)) {
                systemContent = clientReq.system.map((s) => s.text).join("\n\n");
            }
            messages.push({ role: "system", content: systemContent });
        }

        for (const msg of clientReq.messages) {
            if (msg.role === "user") {
                if (typeof msg.content === "string") {
                    messages.push({ role: "user", content: msg.content });
                } else if (Array.isArray(msg.content)) {
                    const toolResults = msg.content.filter((b) => b.type === "tool_result");
                    const normalBlocks = msg.content.filter((b) => b.type !== "tool_result");

                    // OpenAI requires tool responses to immediately follow assistant tool_calls.
                    for (const tr of toolResults) {
                        messages.push({
                            role: "tool",
                            tool_call_id: tr.tool_use_id,
                            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
                        });
                    }

                    if (normalBlocks.length > 0) {
                        const texts = normalBlocks.map((b) => b.text || "").join("\n");
                        messages.push({ role: "user", content: texts });
                    }
                }
            } else if (msg.role === "assistant") {
                if (typeof msg.content === "string") {
                    messages.push({ role: "assistant", content: msg.content });
                } else if (Array.isArray(msg.content)) {
                    const textBlocks = msg.content.filter((b) => b.type === "text");
                    const thinkingBlocks = msg.content.filter((b) => b.type === "thinking");
                    const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");

                    const combinedText = textBlocks
                        .map((b) => b.text)
                        .join("\n");

                    const reasoningText = thinkingBlocks
                        .map((b) => b.thinking)
                        .join("\n");

                    const assistantMsg: OpenAIMessage = {
                        role: "assistant",
                        content: combinedText || null,
                    };
                    
                    if (thinkingBlocks.length > 0) {
                        assistantMsg.reasoning_content = reasoningText;
                    }

                    if (toolUseBlocks.length > 0) {
                        assistantMsg.tool_calls = toolUseBlocks.map((tu) => ({
                            id: tu.id || `call_${Date.now()}`,
                            type: "function",
                            function: {
                                name: tu.name || "",
                                arguments: JSON.stringify(tu.input || {}),
                            },
                        }));
                    }
                    messages.push(assistantMsg);
                }
            }
        }

        const openaiTools: OpenAITool[] | undefined = clientReq.tools?.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
            },
        }));

        let openaiToolChoice: OpenAIRequest["tool_choice"] = undefined;
        if (clientReq.tool_choice) {
            switch (clientReq.tool_choice.type) {
                case "auto":
                    openaiToolChoice = "auto";
                    break;
                case "any":
                    openaiToolChoice = "required";
                    break;
                case "tool":
                    openaiToolChoice = {
                        type: "function",
                        function: { name: clientReq.tool_choice.name || "" },
                    };
                    break;
            }
        }

        const openaiReq: OpenAIRequest = {
            model: clientReq.model,
            messages,
            max_tokens: clientReq.max_tokens,
            stream: clientReq.stream,
            temperature: clientReq.temperature,
            top_p: clientReq.top_p,
            stop: clientReq.stop_sequences,
        };

        if (openaiTools) {
            openaiReq.tools = openaiTools;
        }
        if (openaiToolChoice) {
            openaiReq.tool_choice = openaiToolChoice;
        }
        const reasoningEffort = thinkingConfigToOpenAI(
            buildThinkingConfigFromAnthropic(clientReq.thinking, clientReq.output_config),
        );
        if (reasoningEffort) {
            openaiReq.reasoning_effort = reasoningEffort;
        }

        return openaiReq;
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
        // [DONE] 是上游 openai 流的明确收尾标记,此时所有 usage chunk(含缓存在内的
        // 尾随 usage-only chunk)一定都已到达,统一在这里聚合发出最终的
        // message_delta(携带累积的 usage)+ message_stop。
        const usage = this.pendingUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
        const stopReason = this.pendingStopReason ?? "end_turn";
        const events: AnthropicSSEEvent[] = [
            {
                event: "message_delta",
                data: JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: {
                        input_tokens: usage.inputTokens,
                        output_tokens: usage.outputTokens,
                        ...(usage.cacheReadTokens ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
                    },
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


    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        if (data.error || data.type === "error") {
            return [{ data: rawDataStr, event: "error" }];
        }

        const events: AnthropicSSEEvent[] = [];
        const chunk = data as unknown as OpenAIChunk;

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
                    // Check if this is a new tool call (different id) or continuation of existing one
                    const isNewToolCall = tc.id && tc.id !== this.currentToolCallId;

                    if (isNewToolCall) {
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

                // 只记录 stop_reason 并累积 usage;message_delta/message_stop 统一在
                // [DONE] 时聚合发出(避免像 deepseek 那样把最终 usage、缓存拆到
                // finish_reason 之后的 choices:[] 尾随 chunk 时被过早发出的 message_stop 丢掉)
                this.pendingStopReason = stopReason;
                this.accumulateUsage(chunk);
            }
        }

        // 尾随的纯 usage chunk(choices=[]):无条件累积,不再依赖 pendingStopReason
        if ((!chunk.choices || chunk.choices.length === 0) && chunk.usage) {
            this.accumulateUsage(chunk);
        }

        return events;
    }
}
