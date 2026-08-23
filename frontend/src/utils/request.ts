import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { getAuthToken } from './authSession';
import { getTenantViewId } from './tenantSession';
import { notifyRequestError } from './requestFeedback';
import { normalizeAxiosError } from './requestError';

const instance: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '/api' : ''),
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
});

/**
 * 在 Tauri 环境下，运行时动态更新 baseURL。
 * 由 main.ts 在应用初始化时调用一次。
 */
export function setBaseURL(url: string) {
    instance.defaults.baseURL = url;
}

export function getBaseURL(): string {
    return instance.defaults.baseURL as string || window.location.origin;
}

instance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        const token = getAuthToken();
        console.log('[request] interceptor: token=' + (token ? token.substring(0, 8) + '...' : 'empty') + ' url=' + config.url);
        if (token && config.headers) {
            config.headers['Authorization'] = `Bearer ${token}`;
        }
        // 当前租户视角（root 切换 / admin 自身租户）统一通过 X-Tenant-ID 传递
        const tenantViewId = getTenantViewId();
        if (tenantViewId && config.headers) {
            config.headers['X-Tenant-ID'] = tenantViewId;
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

instance.interceptors.response.use(
    (response) => {
        return response.data;
    },
    (error: AxiosError<unknown>) => {
        const requestError = normalizeAxiosError(error);
        notifyRequestError(requestError);
        return Promise.reject(requestError);
    }
);

export default instance;
