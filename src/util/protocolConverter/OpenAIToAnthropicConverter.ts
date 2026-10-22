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
    OpenAIChunk,
    OpenAIMessage,
    OpenAIRequest,
    OpenAIResponse,
} from "../protocol/openaiTypes";
import {
    buildThinkingConfigFromOpenAI,
    thinkingConfigToAnthropic,
} from "./thinkingConfig";
import protocolConverterUtil from "./protocolConverterUtil";
import { resolveAnthropicMaxTokens } from "./anthropicDefaults";

const ANTHROPIC_TO_OPENAI_STOP_REASON: Record<string, string> = {
    end_turn: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
    stop_sequence: "stop",
};

export class OpenAIToAnthropicConverter extends BaseConverter {
    private currentToolCallIndex = -1;
    private inputTokens = 0;


    public convertRequest(clientReq: OpenAIRequest): AnthropicRequest {
        let systemPrompt: string | undefined;
        const messages: AnthropicRequest["messages"] = [];

        for (const msg of clientReq.messages) {
            if (msg.role === "system") {
                systemPrompt = (systemPrompt ? systemPrompt + "\n\n" : "") + this.contentToText(msg.content);
                continue;
            }

            if (msg.role === "tool") {
                protocolConverterUtil.appendAnthropicMessage(messages, "user", [
                    {
                        type: "tool_result",
                        tool_use_id: msg.tool_call_id || "",
                        content: this.contentToText(msg.content),
                    },
                ]);
                continue;
            }

            if (msg.role === "assistant") {
                if (msg.tool_calls || msg.reasoning_content) {
                    const contentBlocks: AnthropicContentBlock[] = [];

                    if (msg.reasoning_content) {
                        contentBlocks.push({ type: "thinking", thinking: msg.reasoning_content });
                    }

                    const textContent = this.contentToText(msg.content);
                    if (textContent) {
                        contentBlocks.push({ type: "text", text: textContent });
                    }

                    if (msg.tool_calls) {
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
                    }

                    messages.push({ role: "assistant", content: contentBlocks.length > 0 ? contentBlocks : "" });
                    continue;
                }
            }

            if (msg.role === "user" || msg.role === "assistant") {
                protocolConverterUtil.appendAnthropicMessage(messages, msg.role, this.convertMessageContent(msg.content));
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
            // P1-07：Anthropic 必填；缺省值不能取 32768（小上限模型会直接 400）
            max_tokens: resolveAnthropicMaxTokens(clientReq.max_tokens ?? clientReq.max_completion_tokens),
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
        const thinkingOutput = thinkingConfigToAnthropic(
            buildThinkingConfigFromOpenAI(clientReq.reasoning_effort, clientReq.reasoning),
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


    /**
     * OpenAI content → Anthropic content：
     * - 纯文本数组保持原样（两种协议的文本块形状一致）
     * - 含 image_url 时逐块转换，图片 URL 拆成 Anthropic 的 base64 / url source
     * - 无法表达的内容块明确报错，不静默丢弃
     */
    private convertMessageContent(content: OpenAIMessage["content"]): string | AnthropicContentBlock[] {
        if (!Array.isArray(content)) {
            return content || "";
        }

        const blocks: AnthropicContentBlock[] = [];
        for (const part of content) {
            if (part.type === "text") {
                blocks.push({ type: "text", text: part.text ?? "" });
            } else if (part.type === "image_url") {
                blocks.push(this.convertImageUrl(part.image_url));
            } else {
                const unsupportedType = (part as { type?: string }).type ?? "unknown";
                throw new customError.AppError(
                    `Unsupported OpenAI content part type for protocol conversion: ${unsupportedType}`,
                    400,
                );
            }
        }
        return blocks;
    }


    /**
     * OpenAI content → 纯文本（system / tool 消息只承载文本）
     */
    private contentToText(content: OpenAIMessage["content"]): string {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    }


    /**
     * OpenAI image_url → Anthropic image block
     * data URL 拆成 base64 source，其余按远程 URL 透传
     */
    private convertImageUrl(imageUrl: string | { url?: string } | undefined): AnthropicContentBlock {
        const url = typeof imageUrl === "string"
            ? imageUrl
            : imageUrl?.url || "";

        if (!url) {
            throw new customError.AppError("image_url.url is required for image protocol conversion", 400);
        }

        return { type: "image", source: protocolConverterUtil.anthropicImageSourceFromUrl(url) };
    }


    public convertResponse(upstreamRes: AnthropicResponse, requestId?: string): OpenAIResponse {
        let textContent = "";
        let reasoningContent: string | undefined = undefined;
        let toolCalls: OpenAIMessage["tool_calls"] = undefined;

        for (const block of upstreamRes.content) {
            if (block.type === "text") {
                textContent += block.text;
            } else if (block.type === "thinking") {
                reasoningContent = (reasoningContent || "") + block.thinking;
            } else if (block.type === "tool_use") {
                if (!toolCalls) toolCalls = [];
                toolCalls.push({
                    id: block.id || `call_${Date.now()}`,
                    type: "function",
                    function: {
                        name: block.name || "",
                        arguments: JSON.stringify(block.input || {}),
                    },
                });
            }
        }

        const finishReason = ANTHROPIC_TO_OPENAI_STOP_REASON[upstreamRes.stop_reason || "end_turn"] || "stop";
        const finalId = requestId || upstreamRes.id;

        return {
            id: finalId.startsWith("chatcmpl-") ? finalId : `chatcmpl-${finalId.replace("msg_", "")}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: upstreamRes.model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: textContent || null,
                        reasoning_content: reasoningContent,
                        tool_calls: toolCalls,
                    },
                    finish_reason: finishReason as "stop" | "length" | "tool_calls" | "content_filter" | null,
                },
            ],
            usage: {
                prompt_tokens: upstreamRes.usage?.input_tokens || 0,
                completion_tokens: upstreamRes.usage?.output_tokens || 0,
                total_tokens: (upstreamRes.usage?.input_tokens || 0) + (upstreamRes.usage?.output_tokens || 0),
            },
        };
    }


    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        const eventType = data.type as string || "";

        if (eventType === "error" || data.error) {
            return [{ data: rawDataStr, event: "error" }];
        }

        if (eventType === "message_start") {
            const message = data.message as AnthropicStreamMessage | undefined;
            if (message?.model) this.updateModel(message.model);
            if (message?.id) {
                this.updateResponseId(message.id.startsWith("chatcmpl-") ? message.id : `chatcmpl-${message.id.replace("msg_", "")}`);
            }
            this.inputTokens = message?.usage?.input_tokens ?? this.inputTokens;

            const chunk: OpenAIChunk = {
                id: this.responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: this.requestModel,
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", content: "" },
                        finish_reason: null,
                    },
                ],
            };
            return [{ data: JSON.stringify(chunk) }];
        }

        if (eventType === "content_block_start") {
            const block = data.content_block as AnthropicStreamContentBlock | undefined;
            if (!block) return [];
            if (block.type === "tool_use") {
                this.currentToolCallIndex++;
                const chunk: OpenAIChunk = {
                    id: this.responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: this.requestModel,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: this.currentToolCallIndex,
                                        id: block.id,
                                        type: "function",
                                        function: { name: block.name, arguments: "" },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                };
                return [{ data: JSON.stringify(chunk) }];
            }
            if (block.type === "thinking") {
                const chunk: OpenAIChunk = {
                    id: this.responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: this.requestModel,
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: "" },
                            finish_reason: null,
                        },
                    ],
                };
                return [{ data: JSON.stringify(chunk) }];
            }
        }

        if (eventType === "content_block_delta") {
            const delta = data.delta as AnthropicStreamDelta | undefined;
            if (!delta) return [];

            if (delta.type === "text_delta") {
                const chunk: OpenAIChunk = {
                    id: this.responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: this.requestModel,
                    choices: [
                        {
                            index: 0,
                            delta: { content: delta.text },
                            finish_reason: null,
                        },
                    ],
                };
                return [{ data: JSON.stringify(chunk) }];
            }

            if (delta.type === "thinking_delta") {
                const chunk: OpenAIChunk = {
                    id: this.responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: this.requestModel,
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: delta.thinking },
                            finish_reason: null,
                        },
                    ],
                };
                return [{ data: JSON.stringify(chunk) }];
            }

            if (delta.type === "input_json_delta") {
                const chunk: OpenAIChunk = {
                    id: this.responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: this.requestModel,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: this.currentToolCallIndex,
                                        function: { arguments: delta.partial_json },
                                    },
                                ],
                            },
                            finish_reason: null,
                        },
                    ],
                };
                return [{ data: JSON.stringify(chunk) }];
            }
        }

        if (eventType === "message_delta") {
            const delta = data.delta as AnthropicStreamDelta | undefined;
            const usage = data.usage as AnthropicStreamUsage | undefined;
            const finishReason = delta?.stop_reason
                ? ANTHROPIC_TO_OPENAI_STOP_REASON[delta.stop_reason] || "stop"
                : null;

            const chunk: OpenAIChunk = {
                id: this.responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: this.requestModel,
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: finishReason,
                    },
                ],
            };

            if (usage) {
                const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
                const promptTokensBase = usage.input_tokens ?? this.inputTokens;
                // OpenAI 口径：prompt_tokens 为含缓存命中总量，缓存部分单独经 prompt_tokens_details 透传
                const promptTokens = promptTokensBase + cacheReadTokens;
                const completionTokens = usage.output_tokens || 0;
                chunk.usage = {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                    prompt_tokens_details: { cached_tokens: cacheReadTokens },
                };
            }
            return [{ data: JSON.stringify(chunk) }];
        }

        if (eventType === "message_stop") {
            return [{ data: "[DONE]" }];
        }

        return [];
    }
}
