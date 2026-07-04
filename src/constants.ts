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
}

export enum VendorType {
    ALIYUN = "aliyun",
    ALIYUN_CODING = "aliyun_coding",
    VOLCENGINE_CODING = "volcengine_coding",
    DEEPSEEK = "deepseek",
    MIMO = "mimo",
    MIMO_TOKEN_PLAN = "mimo_token_plan",
    OPENCODE_GO = "opencode_go",
    OTHER = "other",
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
