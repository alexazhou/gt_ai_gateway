import type { ReasoningEffort } from "./commonTypes";

/**
 * Responses API 请求/响应类型定义
 *
 * OpenAI Responses API 是一种与 Chat Completions API 不同的格式，
 * 使用 input 数组（而非 messages），支持 function_call / function_call_output 等结构。
 *
 * 参考：https://platform.openai.com/docs/api-reference/responses
 */

// ─── Responses API 请求类型 ───

export interface ResponsesRequest {
    model: string;
    input: ResponsesInputItem[] | string;
    instructions?: string;
    max_output_tokens?: number;
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    tools?: ResponsesTool[];
    tool_choice?: ResponsesToolChoice;
    reasoning?: {
        effort?: ReasoningEffort;
    };
    metadata?: Record<string, unknown>;
}

export type ResponsesInputItem =
    | ResponsesMessageItem
    | ResponsesFunctionCallItem
    | ResponsesFunctionCallOutputItem
    | ResponsesReasoningItem;

export interface ResponsesMessageItem {
    type: "message";
    role: "user" | "assistant" | "system" | "developer";
    content: ResponsesContentPart[] | string;
}

export interface ResponsesFunctionCallItem {
    type: "function_call";
    id?: string;
    call_id: string;
    name: string;
    arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
    type: "function_call_output";
    call_id: string;
    output: string | ResponsesContentPart[];
}

/** 输出文本内容块（非流式 item / 流式 content part 共用） */
export interface ResponsesOutputTextPart {
    type: "output_text";
    text: string;
    annotations?: unknown[];
}

/** 推理摘要块 */
export interface ResponsesSummaryPart {
    type: "summary_text";
    text: string;
}

export interface ResponsesReasoningItem {
    type: "reasoning";
    id?: string;
    encrypted_content?: string;
    summary?: ResponsesSummaryPart[];
}

export type ResponsesContentPart =
    | { type: "input_text"; text: string }
    | ResponsesOutputTextPart
    | { type: "input_image"; image_url?: string; url?: string; file_id?: string; detail?: string }
    | { type: "input_file"; file_data?: string; filename?: string };

export interface ResponsesTool {
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
}

export type ResponsesToolChoice =
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string };

// ─── Responses API 非流式响应类型 ───

export interface ResponsesInputTokenDetails {
    cached_tokens?: number;
}

export interface ResponsesOutputTokenDetails {
    reasoning_tokens?: number;
}

export interface ResponsesUsage {
    input_tokens: number;
    input_tokens_details?: ResponsesInputTokenDetails;
    output_tokens: number;
    output_tokens_details?: ResponsesOutputTokenDetails;
    total_tokens: number;
}

/** 流式事件中的 usage 可能只包含部分字段 */
export type ResponsesStreamUsage = Partial<ResponsesUsage>;

export interface ResponsesNonStreamResponse {
    id: string;
    object: "response";
    created_at: number;
    status: "completed" | "failed" | "in_progress";
    model: string;
    output: ResponsesOutputItem[];
    usage?: ResponsesUsage;
    instructions?: string;
    max_output_tokens?: number;
    temperature?: number;
    top_p?: number;
    tools?: ResponsesTool[];
    tool_choice?: ResponsesToolChoice;
}

export type ResponsesOutputItem =
    | ResponsesOutputMessage
    | ResponsesOutputFunctionCall
    | ResponsesOutputReasoning;

export interface ResponsesOutputMessage {
    type: "message";
    id: string;
    role: "assistant";
    status: "completed";
    content: ResponsesOutputTextPart[];
}

export interface ResponsesOutputFunctionCall {
    type: "function_call";
    id: string;
    call_id: string;
    name: string;
    arguments: string;
    status: "completed";
}

export interface ResponsesOutputReasoning {
    type: "reasoning";
    id: string;
    encrypted_content?: string;
    summary?: ResponsesSummaryPart[];
}

// ─── Responses SSE 事件中转换器实际读取的最小载荷形状（各 converter 共用） ───

export interface ResponsesStreamResponse {
    id?: string;
    model?: string;
    usage?: ResponsesStreamUsage;
    output?: Array<{ type?: string }>;
}

/** 流式 content part 的松散视图（累加器逐事件填充） */
export type ResponsesStreamContentPart = Partial<ResponsesOutputTextPart>;

export interface ResponsesStreamItem {
    id?: string;
    type?: string;
    role?: string;
    status?: string;
    call_id?: string;
    name?: string;
    content?: ResponsesStreamContentPart[];
}

// ─── Responses API 流式事件类型 ───

export type ResponsesStreamEvent =
    | ResponsesEventResponseCreated
    | ResponsesEventResponseInProgress
    | ResponsesEventOutputItemAdded
    | ResponsesEventContentPartAdded
    | ResponsesEventOutputTextDelta
    | ResponsesEventOutputTextDone
    | ResponsesEventContentPartDone
    | ResponsesEventFunctionCallArgsDelta
    | ResponsesEventFunctionCallArgsDone
    | ResponsesEventReasoningSummaryPartAdded
    | ResponsesEventReasoningSummaryTextDelta
    | ResponsesEventReasoningSummaryTextDone
    | ResponsesEventReasoningSummaryPartDone
    | ResponsesEventOutputItemDone
    | ResponsesEventResponseCompleted
    | ResponsesEventError
    | ResponsesEventResponseFailed;

interface ResponsesEventBase {
    type: string;
    sequence_number: number;
}

export interface ResponsesEventResponseCreated extends ResponsesEventBase {
    type: "response.created";
    response: ResponsesNonStreamResponse;
}

export interface ResponsesEventResponseInProgress extends ResponsesEventBase {
    type: "response.in_progress";
    response: { id: string; status: "in_progress" };
}

export interface ResponsesEventOutputItemAdded extends ResponsesEventBase {
    type: "response.output_item.added";
    output_index: number;
    item: ResponsesOutputItem;
}

export interface ResponsesEventContentPartAdded extends ResponsesEventBase {
    type: "response.content_part.added";
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponsesOutputTextPart;
}

export interface ResponsesEventOutputTextDelta extends ResponsesEventBase {
    type: "response.output_text.delta";
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
}

export interface ResponsesEventOutputTextDone extends ResponsesEventBase {
    type: "response.output_text.done";
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;
}

export interface ResponsesEventContentPartDone extends ResponsesEventBase {
    type: "response.content_part.done";
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponsesOutputTextPart;
}

export interface ResponsesEventFunctionCallArgsDelta extends ResponsesEventBase {
    type: "response.function_call_arguments.delta";
    item_id: string;
    output_index: number;
    delta: string;
}

export interface ResponsesEventFunctionCallArgsDone extends ResponsesEventBase {
    type: "response.function_call_arguments.done";
    item_id: string;
    output_index: number;
    arguments: string;
}

export interface ResponsesEventReasoningSummaryPartAdded extends ResponsesEventBase {
    type: "response.reasoning_summary_part.added";
    item_id: string;
    output_index: number;
    summary_index: number;
    part: ResponsesSummaryPart;
}

export interface ResponsesEventReasoningSummaryTextDelta extends ResponsesEventBase {
    type: "response.reasoning_summary_text.delta";
    item_id: string;
    output_index: number;
    summary_index: number;
    delta: string;
}

export interface ResponsesEventReasoningSummaryTextDone extends ResponsesEventBase {
    type: "response.reasoning_summary_text.done";
    item_id: string;
    output_index: number;
    summary_index: number;
    text: string;
}

export interface ResponsesEventReasoningSummaryPartDone extends ResponsesEventBase {
    type: "response.reasoning_summary_part.done";
    item_id: string;
    output_index: number;
    summary_index: number;
    part: ResponsesSummaryPart;
}

export interface ResponsesEventOutputItemDone extends ResponsesEventBase {
    type: "response.output_item.done";
    output_index: number;
    item: ResponsesOutputItem;
}

export interface ResponsesEventResponseCompleted extends ResponsesEventBase {
    type: "response.completed";
    response: ResponsesNonStreamResponse;
}

/** 错误对象：Responses 的两种失败事件都用这个形状（Anthropic 侧对应 error.type / error.message） */
export interface ResponsesErrorDetail {
    code?: string | null;
    message?: string;
}

/** API 级错误事件：整条报文就是错误对象 */
export interface ResponsesEventError {
    type: "error";
    code?: string | null;
    message?: string;
    sequence_number?: number;
}

/** 模型级失败事件：response.status = "failed"，错误详情在 response.error 里 */
export interface ResponsesEventResponseFailed extends ResponsesEventBase {
    type: "response.failed";
    response: {
        id?: string;
        status: "failed";
        error?: ResponsesErrorDetail;
    };
}
