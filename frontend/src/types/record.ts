import type { BaseEntity, PaginationParams } from './index';

export type RequestStatus = 'init' | 'processing' | 'success' | 'failed';
export type FailedCode = 'client_disconnected' | 'upstream_disconnected' | 'stream_incomplete' | 'upstream_parse_error' | null;

/** 记录的 token 用量（后端已按展示口径归一化：prompt_tokens = 非缓存输入，cache_read_tokens 独立返回；上游未返回的字段为 null，返回 0 则为 0） */
export interface RecordUsage {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens?: number | null;
}

export interface Record extends BaseEntity {
    user_id: number | null;
    model_id: number | null;
    request_data: string | null;
    response_data: string | null;
    status: RequestStatus | null;
    failed_code: FailedCode;
    client_format: string | null;
    upstream_format: string | null;
    usage: RecordUsage | null;
    first_token_latency: number | null;
    start_at: string | number | null;
    end_at: string | number | null;
    cost: number;

    // 关联数据
    user_name?: string | null;
    vendor_id?: number | null;
    vendor_name?: string | null;
    model_name?: string | null;
    vendor_model_name?: string | null;
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

// ===== 请求活动日志（时间线） =====

export type RequestActivityStage = 'routing' | 'upstream_attempt' | 'failover' | 'plugin' | 'conversion' | 'result';
export type ActivityLevel = 'info' | 'warn' | 'error';

export interface RecordActivityEntry {
    stage: RequestActivityStage;
    level: ActivityLevel;
    message: string;
    details?: { [key: string]: unknown };
    ts: number;
}

export interface RecordActivityResponse {
    record_id: number;
    activities: RecordActivityEntry[];
}


// 记录详情，包含关联的名称信息
export interface RecordDetail extends Record {
    user_name?: string | null;
    model_name?: string | null;
    vendor_name?: string | null;
    vendor_model_name?: string | null;
}
