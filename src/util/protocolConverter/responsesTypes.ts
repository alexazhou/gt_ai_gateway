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
        effort?: "none" | "low" | "medium" | "high";
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
    role: "user" | "assistant" | "system";
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
    output: string;
}

export interface ResponsesReasoningItem {
    type: "reasoning";
    id?: string;
    encrypted_content?: string;
    summary?: Array<{ type: "summary_text"; text: string }>;
}

export type ResponsesContentPart =
    | { type: "input_text"; text: string }
    | { type: "output_text"; text: string }
    | { type: "input_image"; image_url?: string; url?: string; detail?: string }
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

export interface ResponsesNonStreamResponse {
    id: string;
    object: "response";
    created_at: number;
    status: "completed" | "failed" | "in_progress";
    model: string;
    output: ResponsesOutputItem[];
    usage?: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
    };
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
    content: Array<{
        type: "output_text";
        text: string;
        annotations?: unknown[];
    }>;
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
    summary?: Array<{ type: "summary_text"; text: string }>;
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
    | ResponsesEventResponseCompleted;

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
    part: { type: "output_text"; text: string };
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
    part: { type: "output_text"; text: string; annotations?: unknown[] };
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
    part: { type: "summary_text"; text: string };
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
    part: { type: "summary_text"; text: string };
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
