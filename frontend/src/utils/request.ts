import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { message } from 'ant-design-vue';

const instance: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || '',
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
});

instance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        const token = localStorage.getItem('adminToken');
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
    (error: AxiosError) => {
        const status = error.response?.status;
        const errorMessage = (error.response?.data as any)?.error || error.message;

        switch (status) {
            case 401:
                message.error('未授权，请重新登录');
                localStorage.removeItem('adminToken');
                window.location.href = '/login';
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
                if (errorMessage) {
                    message.error(errorMessage);
                }
        }

        return Promise.reject(error);
    }
);

export default instance;
