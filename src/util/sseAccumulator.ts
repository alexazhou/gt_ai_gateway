/**
 * SSE 消息累加器
 * 用于累积流式 AI 响应，生成完整的响应对象
 */

interface SSEMessage {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices?: Array<{
        index?: number;
        delta?: {
            role?: string;
            content?: string;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

interface AccumulatedResponse {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices: Array<{
        index: number;
        message: {
            role?: string;
            content: string;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

class SSEAccumulator {
    private response: AccumulatedResponse = {
        choices: [{ index: 0, message: { content: "" }, finish_reason: null }],
    };

    /**
     * 添加一条 SSE 消息
     * @param msg - SSE 消息对象
     */
    addMessage(msg: SSEMessage): void {
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
                        message: { content: "" },
                        finish_reason: null,
                    });
                }

                // 累积内容
                if (choice.delta?.content) {
                    this.response.choices[index].message.content +=
                        choice.delta.content;
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
            this.response.usage = msg.usage;
        }
    }

    /**
     * 获取累积的完整响应
     * @returns 完整的响应对象
     */
    getResponse(): AccumulatedResponse {
        return this.response;
    }

    /**
     * 获取累积的文本内容
     * @returns 文本内容
     */
    getText(): string {
        return this.response.choices[0]?.message.content ?? "";
    }

    /**
     * 重置累加器
     */
    reset(): void {
        this.response = {
            choices: [
                { index: 0, message: { content: "" }, finish_reason: null },
            ],
        };
    }
}

export type { SSEMessage, AccumulatedResponse };
export { SSEAccumulator };
