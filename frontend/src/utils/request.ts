import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { getAuthToken } from './authSession';
import { notifyRequestError } from './requestFeedback';
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
        notifyRequestError(requestError);
        return Promise.reject(requestError);
    }
);

export default instance;
