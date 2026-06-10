import type { BaseEntity, PaginationParams } from './index';

export type RequestStatus = 'init' | 'processing' | 'success' | 'failed';
export type FailedCode = 'client_disconnected' | 'upstream_disconnected' | 'stream_incomplete' | null;

export interface Record extends BaseEntity {
    user_id: number | null;
    model_id: number | null;
    request_data: string | null;
    response_data: string | null;
    status: RequestStatus | null;
    failed_code: FailedCode;
    prompt_tokens: number | null;
    output_tokens: number | null;
    first_token_latency: number | null;
    start_at: string | number | null;
    end_at: string | number | null;
    cost: number;

    // 关联数据
    user_name?: string | null;
    vendor_name?: string | null;
    model_name?: string | null;
}

export interface RecordRequestData {
    model: string;
    messages: Array<{
        role: string;
        content: string;
    }>;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
}

export interface RecordResponseData {
    choices?: Array<{
        index: number;
        message?: {
            role: string;
            content: string;
        };
        delta?: {
            content: string;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    error?: {
        message: string;
        code?: string;
    };
}

export interface RecordQuery extends PaginationParams {
    status?: RequestStatus;
    user_ids?: string;
    model_ids?: string;
    start_time?: string;
    end_time?: string;
}

export interface RecordListResponse {
    list: Record[];
    total: number;
}


// 记录详情，包含关联的名称信息
export interface RecordDetail extends Record {
    user_name?: string | null;
    model_name?: string | null;
    vendor_name?: string | null;
}
