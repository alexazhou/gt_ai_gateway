export enum SgRecordStatus {
    INIT = "init",
    PROCESSING = "processing",
    SUCCESS = "success",
    FAILED = "failed",
}

export enum FailedCode {
    CLIENT_DISCONNECTED = "client_disconnected",
    UPSTREAM_DISCONNECTED = "upstream_disconnected",
    STREAM_INCOMPLETE = "stream_incomplete",
    UPSTREAM_ERROR = "upstream_error",
    NO_AVAILABLE_UPSTREAM = "no_available_upstream",
    INSUFFICIENT_BALANCE = "insufficient_balance",
}

export enum RequestActivityStage {
    ROUTING = "routing",
    UPSTREAM_ATTEMPT = "upstream_attempt",
    FAILOVER = "failover",
    PLUGIN = "plugin",
    CONVERSION = "conversion",
    RESULT = "result",
}

export enum ActivityLevel {
    INFO = "info",
    WARN = "warn",
    ERROR = "error",
}

export enum VendorAuthMode {
    API_KEY = "api_key",
    BEARER_TOKEN = "bearer_token",
}

export enum ApiFormat {
    OPENAI = "openai",
    ANTHROPIC = "anthropic",
    RESPONSES = "responses",
}

export enum ModelRoutingMode {
    SINGLE = "single",
    LOAD_BALANCE = "load_balance",
    FIRST_AVAILABLE = "first_available",
}

export const UPSTREAM_FAILURE_COOLDOWN_MS = 30_000;

export const PRICE_UNIT_TOKENS = 1_000_000;
export const MIN_MODEL_PRICE = 0.0001;
// 计费/存储粒度：余额按 0.000001 元（微元）的整数倍取整与扣减
export const MIN_DEDUCTION_UNIT = 0.000001;
// 余额整数缩放倍数：1 元 = 1_000_000 微元（DB 存整数微元，避免浮点）
export const BALANCE_SCALE = 1_000_000;

export enum ClientName {
    CLAUDE_CODE = "claude-code",
    CODEX = "codex",
}

export enum ConnectionMode {
    GATEWAY = "gateway",
    VENDOR = "vendor",
    OFFICIAL = "official",
}

export enum RunMode {
    WORKER = "worker",
    NODE = "node",
}

export enum RecordPayloadStorage {
    AUTO = "auto",
    DATABASE = "database",
    R2 = "r2",
}

export enum UserType {
    NORMAL = "normal",
    ADMIN = "admin",
    ROOT = "root",
}

export enum UserStatus {
    ACTIVE = "active",
    DISABLED = "disabled",
}

export const ROOT_USER_ID = -1;

export enum ConfigKey {
    CCH_REWRITE_ENABLED = "cch_rewrite_enabled",
    RESPONSES_PROMPT_CACHE_KEY_ENABLED = "responses_prompt_cache_key_enabled",
    CLAUDE_CODE_TRACKING_REWRITE_ENABLED = "claudecode_tracking_rewrite_enabled",
    HOST_KEY = "host_key",
    STREAM_LOG_ENABLED = "stream_log_enabled",
    AUTO_UPDATE_ENABLED = "auto_update_enabled",
    TELEMETRY_DISABLED = "telemetry_disabled",
    RECORD_PAYLOAD_ENABLED = "record_payload_enabled",
    RECORD_PAYLOAD_STORAGE = "record_payload_storage",
    MODULE_BILLING_ENABLED = "module_billing_enabled",
    MODULE_API_PLAYGROUND_ENABLED = "module_api_playground_enabled",
}
