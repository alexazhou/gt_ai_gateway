import { Context } from "hono";
import { ApiFormat } from "../constants";

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

function buildLlmErrorResponse(err: Error | AppError, apiFormat: ApiFormat) {
    const message = err.message || "Unknown error";
    let code = "api_error";
    
    if ("code" in err && err.code) {
        code = err.code;
    } else if ("statusCode" in err) {
        if (err.statusCode === 401 || err.statusCode === 403) code = "authentication_error";
        else if (err.statusCode === 404) code = "not_found_error";
        else if (err.statusCode === 400) code = "invalid_request_error";
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
    buildLlmErrorResponse,
};
