export interface ConfigMap {
    cch_rewrite_enabled: string;
    responses_prompt_cache_key_enabled: string;
    claude_code_tracking_rewrite_enabled: string;
    host_key: string;
    stream_log_enabled: string;
    record_payload_enabled: string;
    [key: string]: string;
}

export interface UpdateConfigRequest {
    cch_rewrite_enabled?: string;
    responses_prompt_cache_key_enabled?: string;
    claude_code_tracking_rewrite_enabled?: string;
    host_key?: string;
    stream_log_enabled?: string;
    record_payload_enabled?: string;
    [key: string]: string | undefined;
}
