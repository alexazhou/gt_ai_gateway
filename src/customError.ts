import { Context } from "hono";
import { ApiFormat } from "./constants";

// 使用 Symbol 标记来识别 AppError 实例
const APP_ERROR_SYMBOL = Symbol.for("AppError");


class AppError extends Error {
    readonly [APP_ERROR_SYMBOL] = true;

    constructor(
        public message: string,
        public statusCode: number = 400,
        public code?: string,
    ) {
        super(message);
        this.name = "AppError";
    }
}


class NotFoundError extends AppError {
    constructor(message: string) {
        super(message, 404, "not_found_error");
        this.name = "NotFoundError";
    }
}


/**
 * 限流拒绝（429）：RPM 超限 / 规则配置 rpm=0（不可用）。携带 retryAfterSeconds 供客户端重试；
 * 供应商级限流抛出的实例带 failoverEligible 标记（供路由循环识别，触发 failover 换上游）。
 */
class RateLimitError extends AppError {
    constructor(
        message: string,
        readonly retryAfterSeconds: number = 60,
        readonly failoverEligible: boolean = false,
    ) {
        super(message, 429, "rate_limit_error");
        this.name = "RateLimitError";
    }
}


/** 访问控制拒绝（403）：access_control 规则命中即拒绝（deny-if-true，无白名单模式） */
class AccessDeniedError extends AppError {
    constructor(message: string) {
        super(message, 403, "access_denied");
        this.name = "AccessDeniedError";
    }
}


/**
 * 写 SSE 到客户端失败（客户端断开）的内部错误；供流式响应的外层 catch 按错误类型归类原因
 */
class ClientWriteError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "ClientWriteError";
    }
}

function buildLlmErrorResponse(err: Error | AppError, apiFormat: ApiFormat) {
    const message = err.message || "Unknown error";
    let code = "api_error";
    
    if ("code" in err && err.code) {
        code = err.code;
    } else if ("statusCode" in err) {
        if (err.statusCode === 401 || err.statusCode === 403) code = "authentication_error";
        else if (err.statusCode === 404) code = "not_found_error";
        else if (err.statusCode === 400) code = "invalid_request_error";
        else if (err.statusCode === 429) code = "rate_limit_error";
    }
    
    if (apiFormat === ApiFormat.ANTHROPIC) {
        return {
            type: "error",
            error: {
                type: code,
                message: message
            }
        };
    } else if (apiFormat === ApiFormat.OPENAI || apiFormat === ApiFormat.RESPONSES) {
        return {
            error: {
                message: message,
                type: code,
                param: null,
                code: code
            }
        };
    } else {
        // 兜底返回格式
        return {
            error: message,
            code: code
        };
    }
}


export default {
    AppError,
    NotFoundError,
    ClientWriteError,
    RateLimitError,
    AccessDeniedError,
    buildLlmErrorResponse,
};
