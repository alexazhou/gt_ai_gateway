import type { AxiosError } from 'axios';

interface AppRequestErrorOptions {
    status?: number;
    data?: unknown;
    handled?: boolean;
}

export class AppRequestError extends Error {
    status?: number;
    data?: unknown;
    handled: boolean;

    constructor(message: string, options: AppRequestErrorOptions = {}) {
        super(message);
        this.name = 'AppRequestError';
        this.status = options.status;
        this.data = options.data;
        this.handled = options.handled ?? false;
    }
}

/**
 * 从后端返回的错误响应中提取展示内容。
 * 策略保持简单直接：字符串原样返回，JSON 对象直接序列化展示，
 * 确保页面能看到上游返回的具体错误内容，而不是只显示 HTTP 状态码。
 */
export function extractErrorMessage(data: unknown, fallback: string = '请求失败'): string {
    if (typeof data === 'string' && data.trim()) {
        return data;
    }

    if (typeof data !== 'object' || data === null) {
        return fallback;
    }

    try {
        const serialized = JSON.stringify(data, null, 2);
        if (serialized) {
            return serialized;
        }
    } catch {
        // 忽略序列化错误，继续走 fallback
    }

    return fallback;
}

export function createHttpError(
    status: number,
    data?: unknown,
    fallback: string = '请求失败',
): AppRequestError {
    return new AppRequestError(extractErrorMessage(data, fallback), { status, data });
}

export function normalizeAxiosError(error: AxiosError<unknown>): AppRequestError {
    if (error.response) {
        return createHttpError(error.response.status, error.response.data, error.message);
    }

    return new AppRequestError(error.message || '请求失败');
}

export function toAppRequestError(error: unknown, fallback: string = '请求失败'): AppRequestError {
    if (error instanceof AppRequestError) {
        return error;
    }

    if (error instanceof Error) {
        return new AppRequestError(error.message || fallback);
    }

    return new AppRequestError(fallback);
}
