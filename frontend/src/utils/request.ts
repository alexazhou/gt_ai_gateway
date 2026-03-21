import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { message } from 'ant-design-vue/es';
import { clearAuthToken, getAuthToken } from './authSession';
import { normalizeAxiosError } from './requestError';

const instance: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '/api' : ''),
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
});

instance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        const token = getAuthToken();
        if (token && config.headers) {
            config.headers['Authorization'] = `Bearer ${token}`;
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
        const { status } = requestError;

        switch (status) {
            case 401:
                message.error('未授权，请重新登录');
                clearAuthToken();
                if (typeof window !== 'undefined' && window.location.hash !== '#/login') {
                    window.location.hash = '#/login';
                }
                break;
            case 403:
                message.error('权限不足');
                break;
            case 404:
                message.error('资源不存在');
                break;
            case 500:
                message.error('服务器错误');
                break;
            default:
                if (requestError.message) {
                    message.error(requestError.message);
                }
        }

        return Promise.reject(requestError);
    }
);

export default instance;
