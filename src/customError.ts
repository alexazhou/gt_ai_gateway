import { Context } from "hono";
import { ApiFormat, FailedCode } from "./constants";

// 使用 Symbol 标记来识别 AppError 实例。
//
// P2-19：这个标记原来只「写」不「读」——定义完就没被检查过，跨 realm / 重复打包导致
// `instanceof` 失效时没有任何兜底。现在统一走 isAppError()：先 Symbol、再 instanceof。
const APP_ERROR_SYMBOL = Symbol.for("AppError");

export type AppErrorKind = "AppError" | "NotFoundError" | "ClientWriteError" | "RateLimitError" | "AccessDeniedError";

/**
 * 判定错误是否是 AppError（可进一步限定具体子类）。
 *
 * 用 Symbol.for（全局注册表）而不是 instanceof 单条路：同一份代码被不同路径/不同 realm
 * 加载时构造函数不是同一个引用，instanceof 会误判为 false，进而把 4xx 当 500 处理。
 */
function isAppError(error: unknown): error is AppError;
function isAppError(error: unknown, kind: "AppError"): error is AppError;
function isAppError(error: unknown, kind: "NotFoundError"): error is NotFoundError;
function isAppError(error: unknown, kind: "ClientWriteError"): error is ClientWriteError;
function isAppError(error: unknown, kind: "RateLimitError"): error is RateLimitError;
function isAppError(error: unknown, kind: "AccessDeniedError"): error is AccessDeniedError;
function isAppError(error: unknown, kind?: AppErrorKind): error is AppError {
    if (error === null || typeof error !== "object") {
        return false;
    }
    const marked = (error as Record<symbol, unknown>)[APP_ERROR_SYMBOL] === true;
    if (!marked && !(error instanceof AppError)) {
        return false;
    }
    if (!kind) {
        return true;
    }
    // 子类各自在构造器里设置了 name，跨 realm 也能区分（标记只区分「是不是 AppError」）
    return (error as Error).name === kind;
}


class AppError extends Error {
    readonly [APP_ERROR_SYMBOL] = true;

    constructor(
        public message: string,
        public statusCode: number = 400,
        public code?: string,
        /**
         * 落库用的失败归因（record.failed_code）。未指定时由调用方兜底为 unknown_error；
         * 典型用法：协议转换失败 → FailedCode.CONVERSION_ERROR，便于按原因统计排障。
         */
        public failedCode?: FailedCode,
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
        readonly ruleId?: number,
        readonly ruleName?: string,
    ) {
        super(message, 429, "rate_limit_error");
        this.name = "RateLimitError";
    }
}


/** 访问控制拒绝（403）：forbid_access 规则命中即拒绝（deny-if-true，无白名单模式） */
class AccessDeniedError extends AppError {
    constructor(message: string, readonly ruleId?: number, readonly ruleName?: string) {
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
    isAppError,
    buildLlmErrorResponse,
};
