export interface ConfigMap {
    cch_rewrite_enabled: string;
    responses_prompt_cache_key_enabled: string;
    claudecode_tracking_rewrite_enabled: string;
    session_header_enabled: string;
    host_key: string;
    stream_log_enabled: string;
    record_payload_enabled: string;
    record_payload_storage: string;
    [key: string]: string;
}

export interface UpdateConfigRequest {
    cch_rewrite_enabled?: string;
    responses_prompt_cache_key_enabled?: string;
    claudecode_tracking_rewrite_enabled?: string;
    session_header_enabled?: string;
    host_key?: string;
    stream_log_enabled?: string;
    record_payload_enabled?: string;
    record_payload_storage?: string;
    [key: string]: string | undefined;
}
