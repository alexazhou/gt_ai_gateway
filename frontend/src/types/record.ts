import type { BaseEntity, PaginationParams } from './index';

export type RequestStatus = 'init' | 'processing' | 'success' | 'failed';
export type FailedCode = 'client_disconnected' | 'upstream_disconnected' | 'stream_incomplete' | 'upstream_error' | 'sse_parse_error' | 'upstream_timeout' | 'recovered_orphan' | 'unknown_error' | null;

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

/** 孤儿清理的进度分母快照（开始清理前取一次，之后靠累加增量算进度） */
export interface OrphanCleanupStats {
    payload_total: number;
    activity_total: number;
    page_size: number;
    max_page_size: number;
}

/** 一片孤儿清理的游标入参：首片传 null，之后回填上一次返回的 next_* */
export interface OrphanCleanupStepInput {
    after_key: string | null;
    after_activity_id: number | null;
    limit?: number;
}

/** 一片孤儿清理的结果：计数是本片增量，调用方自行累加 */
export interface OrphanCleanupStepResult {
    next_after_key: string | null;
    next_after_activity_id: number | null;
    scanned_payloads: number;
    deleted_payloads: number;
    scanned_activities: number;
    deleted_activities: number;
    done: boolean;
}
