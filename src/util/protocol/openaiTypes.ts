/**
 * OpenAI Chat Completions API 协议类型。
 */

import type { ReasoningEffort } from "./commonTypes";

// ─── 公共子结构 ───

export interface OpenAIFunctionCall {
    name: string;
    arguments: string;
}

/** 非流式响应 / 请求中的完整 tool call */
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: OpenAIFunctionCall;
}

/** 流式 delta 中的 tool call：逐片到达，字段可缺省 */
export interface OpenAIStreamToolCall {
    index?: number;
    id?: string;
    type?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
}

export interface OpenAIPromptTokenDetails {
    cached_tokens?: number;
    /** 部分上游用该字段报缓存写入（对应 Anthropic 的 cache_creation_input_tokens） */
    cache_write_tokens?: number;
}

export interface OpenAICompletionTokenDetails {
    reasoning_tokens?: number;
}

export interface OpenAIUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: OpenAIPromptTokenDetails;
    completion_tokens_details?: OpenAICompletionTokenDetails;
}

/** 流式 chunk 的 usage 可能只包含部分字段 */
export type OpenAIStreamUsage = Partial<OpenAIUsage>;

/** 流式 delta，各字段逐片到达 */
export interface OpenAIStreamDelta {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    function_call?: {
        name?: string;
        arguments?: string;
    };
    tool_calls?: OpenAIStreamToolCall[];
}

// ─── 请求 ───

/** OpenAI Chat Completions 的多模态内容块 */
export type OpenAIContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | OpenAIContentPart[] | null;
    reasoning_content?: string | null;
    name?: string;
    tool_calls?: OpenAIToolCall[];
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

// ─── 响应 ───

export interface OpenAIResponseChoice {
    index: number;
    message: {
        role: "assistant";
        content: string | null;
        reasoning_content?: string | null;
        tool_calls?: OpenAIToolCall[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: OpenAIResponseChoice[];
    usage: OpenAIUsage;
}

export interface OpenAIChunkChoice {
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: string | null;
}

export interface OpenAIChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: OpenAIChunkChoice[];
    usage?: OpenAIUsage;
}

export interface OpenAIStreamChoice {
    index?: number;
    delta?: OpenAIStreamDelta;
    finish_reason?: string | null;
}

/** 流式 chunk 的松散视图：上游可能只返回部分字段，供累加器读取 */
export interface OpenAIStreamChunk {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices?: OpenAIStreamChoice[];
    usage?: OpenAIStreamUsage;
}

/** OpenAI 兼容上游在流内报错：错误挂在 error 字段上（与官方 SDK 一致），这种 chunk 没有 choices */
export interface OpenAIErrorChunk {
    error: {
        message: string;
        type?: string;
        code?: string | null;
        param?: string | null;
    };
}

/** OpenAI 兼容上游在流内报错：整条报文就是错误对象（部分兼容上游的写法） */
export interface OpenAIErrorPayload {
    type: "error";
    code?: string | null;
    message?: string;
}

export type OpenAIStreamError = OpenAIErrorChunk | OpenAIErrorPayload;
