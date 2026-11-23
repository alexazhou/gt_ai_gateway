/**
 * Anthropic Messages API 协议类型。
 */

import type { ReasoningEffort } from "./commonTypes";

/**
 * Anthropic 显式缓存断点标记（Prompt Caching）。
 *
 * 只声明协议允许的形态：`type` 目前只有 `ephemeral`；`ttl` 由协议保留，
 * 本网关第一版**不设置 ttl**（使用目标协议默认短期缓存）。
 */
export interface AnthropicCacheControl {
    type: "ephemeral";
    ttl?: string;
}

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
    /**
     * 缓存断点。`thinking` 块**不作为**自动补全位置（见
     * `doc/tech/anthropic_cache_control_design.md` §4.3），此字段仅为类型完整。
     */
    cache_control?: AnthropicCacheControl;
}

/** `system` 数组中的文本块（转换器统一产出块数组，缓存标记只在块上加字段、不改形状）。 */
export interface AnthropicTextBlock {
    type: "text";
    text: string;
    cache_control?: AnthropicCacheControl;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
    /** 工具定义上的缓存断点（`input_schema` 内的同名键属业务数据，不是断点）。 */
    cache_control?: AnthropicCacheControl;
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
    system?: string | AnthropicTextBlock[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    tools?: AnthropicTool[];
    tool_choice?: {
        type: "auto" | "any" | "none" | "tool";
        name?: string;
    };
    thinking?: AnthropicThinkingConfig;
    output_config?: AnthropicOutputConfig;
    metadata?: Record<string, unknown>;
}

export interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface AnthropicResponse {
    id: string;
    type: "message";
    role: "assistant";
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
    stop_sequence?: string | null;
    usage: AnthropicUsage;
}

export interface AnthropicSSEEvent {
    event: string;
    data: string;
}

// ─── SSE 事件中实际读取的最小载荷形状（各 converter / accumulator 共用） ───

/** 流式事件中的 usage 可能只包含部分字段 */
export type AnthropicStreamUsage = Partial<AnthropicUsage>;

export interface AnthropicStreamMessage {
    id?: string;
    model?: string;
    usage?: AnthropicStreamUsage;
}

/** 流式 content_block_start 中可能只包含部分字段 */
export type AnthropicStreamContentBlock = Partial<AnthropicContentBlock>;

export interface AnthropicStreamDelta {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
}

/** Anthropic 的流内错误事件体（SSE 外层是 event: error） */
export interface AnthropicErrorEvent {
    type: "error";
    error: {
        type: string;
        message: string;
    };
}
