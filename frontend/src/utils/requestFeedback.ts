import { message } from 'ant-design-vue/es';
import { clearAuthToken } from './authSession';
import type { AppRequestError } from './requestError';
import { toAppRequestError } from './requestError';

export function notifySuccess(content: string): void {
    message.success(content);
}

export function notifyWarning(content: string): void {
    message.warning(content);
}

export function notifyError(content: string): void {
    message.error(content);
}

export function handleUnauthorizedRedirect(): void {
    clearAuthToken();
    if (typeof window !== 'undefined' && window.location.hash !== '#/login') {
        window.location.hash = '#/login';
    }
}

function isLoginRoute(): boolean {
    return typeof window !== 'undefined' && window.location.hash === '#/login';
}

export function notifyRequestError(error: unknown, fallback: string = '请求失败'): AppRequestError {
    const requestError = toAppRequestError(error, fallback);
    if (requestError.handled) {
        return requestError;
    }

    requestError.handled = true;
    const { status } = requestError;

    switch (status) {
        case 401:
            if (!isLoginRoute()) {
                notifyError('未授权，请重新登录');
            }
            handleUnauthorizedRedirect();
            break;
        case 403:
            notifyError('权限不足');
            break;
        case 404:
            notifyError('资源不存在');
            break;
        case 500:
            notifyError('服务器错误');
            break;
        default:
            notifyError(requestError.message || fallback);
            break;
    }

    return requestError;
}
