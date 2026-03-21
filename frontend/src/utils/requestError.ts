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

function getObjectValue(record: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function extractErrorMessage(data: unknown, fallback: string = '请求失败'): string {
    if (typeof data === 'string' && data.trim()) {
        return data;
    }

    if (typeof data !== 'object' || data === null) {
        return fallback;
    }

    const record = data as Record<string, unknown>;
    const errorValue = getObjectValue(record, 'error');
    const messageValue = getObjectValue(record, 'message');

    if (typeof errorValue === 'string' && errorValue.trim()) {
        return errorValue;
    }

    if (typeof errorValue === 'object' && errorValue !== null) {
        const nestedMessage = getObjectValue(errorValue as Record<string, unknown>, 'message');
        if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
            return nestedMessage;
        }
    }

    if (typeof messageValue === 'string' && messageValue.trim()) {
        return messageValue;
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
