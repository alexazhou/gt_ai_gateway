/**
 * Anthropic Messages 流式响应累加器
 * 累积 Messages delta 流，组装成与 OpenAI Chat 同构的完整响应对象（ChatAccumulatedResponse）。
 * 与 openaiChatAccumulator / responsesAccumulator 并列，各处理一种协议。
 */

import type { ProtocolStreamEvent } from "../protocolConverter/protocolTypes";
import { AccumulatorBase } from "./accumulatorBase";
import type { ChatAccumulatedResponse } from "./chatAccumulatorTypes";

interface AnthropicChunk {
    type?: string;
    message?: {
        id?: string;
        type?: string;
        role?: string;
        content?: any[];
        model?: string;
        stop_reason?: string | null;
        stop_sequence?: string | null;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
        };
    };
    content_block?: {
        type?: "thinking" | "text" | "tool_use";
        thinking?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
    };
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
    };
    delta?: {
        type?: "text_delta" | "thinking_delta" | "signature_delta" | "input_json_delta";
        text?: string;
        thinking?: string;
        signature?: string;
        partial_json?: string;
        stop_reason?: string | null;
        stop_sequence?: string | null;
    };
    index?: number;
}

export class AnthropicMessagesAccumulator extends AccumulatorBase {
    private response: ChatAccumulatedResponse = {
        choices: [{ index: 0, message: { content: "", thinking: "", signature: "" }, finish_reason: null }],
    };

    /**
     * 添加一条客户端 SSE 事件（原始 data 字符串）
     * 内部解析并检测完成/错误/首个输出。
     */
    addEvent(clientEvent: ProtocolStreamEvent): void {
        let parsed: AnthropicChunk;
        try {
            parsed = JSON.parse(clientEvent.data);
        } catch (e) {
            console.log("Failed to parse SSE data:", clientEvent.data, e);
            return;
        }

        // 错误事件检测
        if (clientEvent.event === "error" || (parsed as any)?.type === "error" || (parsed as any)?.error !== undefined) {
            this.markError(parsed);
            return;
        }

        // Anthropic 流结束标记：message_stop 仍需累积 usage/stop_reason
        if (clientEvent.event === "message_stop") {
            this.handleAnthropicMessage(parsed, clientEvent.event);
            this.markCompleted();
            return;
        }

        // 其余非完成/非错误事件：标记首个输出已到达
        // （保留原 `!isCompleted` 的 TTFT 语义：含 message_start 等首事件）
        this.markOutputStarted();
        this.handleAnthropicMessage(parsed, clientEvent.event);
    }

    /**
     * 处理 Anthropic 格式的消息
     * @param msg - SSE 消息对象
     * @param eventType - SSE 事件类型（message_start, content_block_delta, message_delta, message_stop 等）
     *
     * 事件处理逻辑：
     * - message_start: 保存 id, model, role, 初始 usage
     * - content_block_delta: 根据 delta.type 处理
     *   - thinking_delta → message.thinking += delta.thinking
     *   - signature_delta → message.signature = delta.signature
     *   - text_delta → message.content += delta.text
     * - message_delta: 更新 stop_reason (在 delta 中) 和最终 usage
     * - message_stop: 响应结束（无需处理）
     */
    private handleAnthropicMessage(msg: AnthropicChunk, eventType?: string): void {
        // message_start 事件：保存基本信息
        if (eventType === 'message_start' && msg.message) {
            if (msg.message.id) this.response.id = msg.message.id;
            if (msg.message.model) this.response.model = msg.message.model;
            if (msg.message.role) this.response.choices[0].message.role = msg.message.role;

            // 初始化 usage（input_tokens 在这里提供）
            if (msg.message.usage) {
                this.response.usage = {
                    prompt_tokens: msg.message.usage.input_tokens,
                    completion_tokens: msg.message.usage.output_tokens || 0,
                    cache_read_tokens: msg.message.usage.cache_read_input_tokens,
                };
            }
            return;
        }

        if (eventType === "content_block_start" && msg.content_block?.type === "tool_use") {
            const toolUseList = this.response.choices[0].message.tool_use ?? [];
            const toolIndex = msg.index ?? 0;

            while (toolUseList.length <= toolIndex) {
                toolUseList.push({ input_json: "" });
            }

            toolUseList[toolIndex] = {
                ...toolUseList[toolIndex],
                id: msg.content_block.id ?? toolUseList[toolIndex].id,
                name: msg.content_block.name ?? toolUseList[toolIndex].name,
                input: msg.content_block.input ?? toolUseList[toolIndex].input,
                input_json: toolUseList[toolIndex].input_json ?? "",
            };

            this.response.choices[0].message.tool_use = toolUseList;
            return;
        }

        // content_block_delta 事件：累积内容增量
        if (eventType === 'content_block_delta' && msg.delta) {
            const deltaType = msg.delta.type;

            // 根据 delta.type 区分处理
            if (deltaType === 'thinking_delta' && msg.delta.thinking) {
                // 累积 thinking 内容到 choices[0].message.thinking
                if (this.response.choices[0].message.thinking === undefined) {
                    this.response.choices[0].message.thinking = "";
                }
                this.response.choices[0].message.thinking += msg.delta.thinking;
            } else if (deltaType === 'signature_delta' && msg.delta.signature) {
                // 保存 thinking 签名（必需，用于工具调用）
                this.response.choices[0].message.signature = msg.delta.signature;
            } else if (deltaType === 'text_delta' && msg.delta.text) {
                // 累积 text 内容到 choices[0].message.content
                this.response.choices[0].message.content += msg.delta.text;
            } else if (deltaType === "input_json_delta" && msg.delta.partial_json !== undefined) {
                const toolUseList = this.response.choices[0].message.tool_use ?? [];
                const toolIndex = msg.index ?? 0;

                while (toolUseList.length <= toolIndex) {
                    toolUseList.push({ input_json: "" });
                }

                toolUseList[toolIndex].input_json = (toolUseList[toolIndex].input_json ?? "") + msg.delta.partial_json;
                this.response.choices[0].message.tool_use = toolUseList;
            }
            return;
        }

        // message_delta/message_stop 事件：更新 stop_reason 和最终 usage
        if (eventType === 'message_delta' || eventType === 'message_stop') {
            // stop_reason 可能在 delta 对象中（message_delta）或直接在消息中
            const stopReason = msg.delta?.stop_reason ?? msg.message?.stop_reason;
            if (stopReason !== undefined) {
                this.response.choices[0].finish_reason = stopReason;
            }

            // 更新最终的 usage（output_tokens 在这里最终确定）
            if (msg.message?.usage || msg.usage) {
                const usage = msg.usage || msg.message?.usage;
                if (usage) {
                    const promptTokens = usage.input_tokens ?? this.response.usage?.prompt_tokens ?? 0;
                    const completionTokens = usage.output_tokens ?? this.response.usage?.completion_tokens ?? 0;
                    this.response.usage = {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        cache_read_tokens: usage.cache_read_input_tokens ?? this.response.usage?.cache_read_tokens,
                    };
                }
            }
            return;
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
     * 获取累积的 usage（来自 message_start / message_delta / message_stop）
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
    AnthropicMessagesAccumulator,
};
