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

export enum ApiFormat {
    OPENAI = "openai",
    ANTHROPIC = "anthropic",
    GOOGLE = "google",
    RESPONSES = "responses",
}

export enum UserType {
    NORMAL = "normal",
    ADMIN = "admin",
    ROOT = "root",
}

export const ROOT_USER_ID = -1;
