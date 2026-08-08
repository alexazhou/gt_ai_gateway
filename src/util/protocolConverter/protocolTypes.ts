import type { ReasoningEffort } from "./thinkingConfig";

export interface AnthropicContentBlock {
    type: "text" | "image" | "tool_use" | "tool_result" | "thinking";
    text?: string;
    source?: {
        type: string;
        media_type?: string;
        data?: string;
        url?: string;
    };
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: string | AnthropicContentBlock[];
    tool_use_id?: string;
    thinking?: string;
    signature?: string;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicThinkingConfig {
    type: "adaptive" | "enabled" | "disabled";
    budget_tokens?: number;
}

export interface AnthropicOutputConfig {
    effort: ReasoningEffort;
}

export interface AnthropicRequest {
    model: string;
    max_tokens: number;
    messages: Array<{
        role: "user" | "assistant";
        content: string | AnthropicContentBlock[];
    }>;
    system?: string | Array<{ type: "text"; text: string }>;
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    tools?: AnthropicTool[];
    tool_choice?: {
        type: "auto" | "any" | "tool";
        name?: string;
    };
    thinking?: AnthropicThinkingConfig;
    output_config?: AnthropicOutputConfig;
    metadata?: Record<string, unknown>;
}

export interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    reasoning_content?: string | null;
    name?: string;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
}

export interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

export interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    max_completion_tokens?: number;
    stream?: boolean;
    stream_options?: { include_usage: boolean };
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    tools?: OpenAITool[];
    tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
    reasoning_effort?: ReasoningEffort;
    reasoning?: {
        effort?: ReasoningEffort;
    };
}

export interface AnthropicResponse {
    id: string;
    type: "message";
    role: "assistant";
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
    stop_sequence?: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

export interface OpenAIResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: "assistant";
            content: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
                id: string;
                type: "function";
                function: {
                    name: string;
                    arguments: string;
                };
            }>;
        };
        finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: {
            cached_tokens?: number;
        };
        completion_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
}

export interface AnthropicSSEEvent {
    event: string;
    data: string;
}

export interface ProtocolStreamEvent {
    data: string;
    event?: string;
    id?: string;
}

export interface OpenAIChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: "function";
                function: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
