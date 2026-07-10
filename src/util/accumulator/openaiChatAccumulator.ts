/**
 * OpenAI Chat Completions 流式响应累加器
 * 累积 Chat Completions delta 流，组装成完整响应对象。
 * 与 anthropicMessagesAccumulator / responsesAccumulator 并列，各处理一种协议。
 */

import type { ProtocolStreamEvent } from "../protocolConverter/protocolTypes";
import { AccumulatorBase } from "./accumulatorBase";
import type { ChatAccumulatedResponse } from "./chatAccumulatorTypes";

interface OpenAIChatChunk {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices?: Array<{
        index?: number;
        delta?: {
            role?: string;
            content?: string;
            reasoning_content?: string;
            function_call?: {
                name?: string;
                arguments?: string;
            };
            tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
}

export class OpenAIChatAccumulator extends AccumulatorBase {
    private response: ChatAccumulatedResponse = {
        choices: [{ index: 0, message: { content: "", thinking: "", signature: "" }, finish_reason: null }],
    };

    /**
     * 添加一条客户端 SSE 事件（原始 data 字符串）
     * 内部解析并检测完成/错误/首个输出。
     */
    addEvent(clientEvent: ProtocolStreamEvent): void {
        const data = clientEvent.data;

        // OpenAI 流结束标记
        if (data === "[DONE]") {
            this.markCompleted();
            return;
        }

        let parsed: OpenAIChatChunk;
        try {
            parsed = JSON.parse(data);
        } catch (e) {
            console.log("Failed to parse SSE data:", data, e);
            return;
        }

        // 错误事件检测
        if ((parsed as any)?.type === "error" || (parsed as any)?.error !== undefined) {
            this.markError(parsed);
            return;
        }

        // 其余非完成/非错误事件：标记首个输出已到达
        // （保留原 `!isCompleted` 的 TTFT 语义：含 role:assistant 等首 chunk）
        this.markOutputStarted();
        this.handleOpenAIMessage(parsed);
    }

    /**
     * 处理 OpenAI 格式的消息
     */
    private handleOpenAIMessage(msg: OpenAIChatChunk): void {
        // 保存基本信息（只保存一次）
        if (msg.id) this.response.id = msg.id;
        if (msg.object) this.response.object = msg.object;
        if (msg.created) this.response.created = msg.created;
        if (msg.model) this.response.model = msg.model;

        // 处理 choices
        if (msg.choices) {
            for (const choice of msg.choices) {
                const index = choice.index ?? 0;

                // 确保 choices 数组足够大
                while (this.response.choices.length <= index) {
                    this.response.choices.push({
                        index: this.response.choices.length,
                        message: { content: "", thinking: "", signature: "" },
                        finish_reason: null,
                    });
                }

                // 累积内容
                if (choice.delta?.content) {
                    this.response.choices[index].message.content +=
                        choice.delta.content;
                }

                // 累积推理内容（o 系列 reasoning 模型）
                if (choice.delta?.reasoning_content) {
                    this.response.choices[index].message.reasoning_content =
                        (this.response.choices[index].message.reasoning_content ?? "") +
                        choice.delta.reasoning_content;
                }

                if (choice.delta?.function_call) {
                    const existingFunctionCall = this.response.choices[index].message.function_call ?? {
                        arguments: "",
                    };
                    existingFunctionCall.name = choice.delta.function_call.name ?? existingFunctionCall.name;
                    existingFunctionCall.arguments += choice.delta.function_call.arguments ?? "";
                    this.response.choices[index].message.function_call = existingFunctionCall;
                }

                if (choice.delta?.tool_calls) {
                    const toolCalls = this.response.choices[index].message.tool_calls ?? [];

                    for (const toolCallDelta of choice.delta.tool_calls) {
                        const toolIndex = toolCallDelta.index ?? 0;

                        while (toolCalls.length <= toolIndex) {
                            toolCalls.push({
                                function: {
                                    arguments: "",
                                },
                            });
                        }

                        const toolCall = toolCalls[toolIndex];
                        toolCall.id = toolCallDelta.id ?? toolCall.id;
                        toolCall.type = toolCallDelta.type ?? toolCall.type;
                        toolCall.function.name = toolCallDelta.function?.name ?? toolCall.function.name;
                        toolCall.function.arguments += toolCallDelta.function?.arguments ?? "";
                    }

                    this.response.choices[index].message.tool_calls = toolCalls;
                }

                // 保存 role
                if (choice.delta?.role) {
                    this.response.choices[index].message.role =
                        choice.delta.role;
                }

                // 更新 finish_reason
                if (choice.finish_reason !== undefined) {
                    this.response.choices[index].finish_reason =
                        choice.finish_reason;
                }
            }
        }

        // 保存 usage 信息（最后一个消息中才包含）
        if (msg.usage) {
            this.response.usage = {
                prompt_tokens: msg.usage.prompt_tokens,
                completion_tokens: msg.usage.completion_tokens,
                cache_read_tokens: (msg.usage as any).prompt_tokens_details?.cached_tokens ?? this.response.usage?.cache_read_tokens,
                completion_tokens_details: msg.usage.completion_tokens_details,
            };
        }
    }

    /**
     * 获取累积的完整响应
     */
    getResponse(): ChatAccumulatedResponse {
        const toolUseList = this.response.choices[0]?.message.tool_use;
        if (toolUseList) {
            for (const toolUse of toolUseList) {
                if (!toolUse) continue;
                if (toolUse.input_json) {
                    try {
                        toolUse.input = JSON.parse(toolUse.input_json);
                    } catch {
                        // Keep raw input_json when partial JSON is invalid or incomplete.
                    }
                }
            }
        }
        return this.response;
    }

    /**
     * 获取累积的文本内容
     */
    getText(): string {
        return this.response.choices[0]?.message.content ?? "";
    }

    /**
     * 获取累积的 usage（来自流末尾 chunk）
     */
    getUsage(): ChatAccumulatedResponse["usage"] | null {
        return this.response.usage ?? null;
    }

    /**
     * 重置累加器
     */
    reset(): void {
        this.response = {
            choices: [
                { index: 0, message: { content: "", thinking: "", signature: "" }, finish_reason: null },
            ],
        };
        this.resetState();
    }
}

export default {
    OpenAIChatAccumulator,
};
