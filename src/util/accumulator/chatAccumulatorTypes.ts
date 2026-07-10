/**
 * Chat 族累加器共享类型
 * OpenAIChatAccumulator 和 AnthropicMessagesAccumulator 都把流累积成这个统一形态
 * （Anthropic 的 tool_use/thinking/signature 等字段也并入其中，便于上层统一处理）。
 */

export interface ChatAccumulatedResponse {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices: Array<{
        index: number;
        message: {
            role?: string;
            content: string;
            reasoning_content?: string;
            thinking?: string;
            signature?: string;
            function_call?: {
                name?: string;
                arguments: string;
            };
            tool_calls?: Array<{
                id?: string;
                type?: string;
                function: {
                    name?: string;
                    arguments: string;
                };
            }>;
            tool_use?: Array<{
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
                input_json?: string;
            }>;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cache_read_tokens?: number;
        completion_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
}
