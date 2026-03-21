import request from '@/utils/request';
import type { StatusResponse, WelcomeResponse } from '@/types/system';

export function welcome(): Promise<WelcomeResponse> {
    return request.get('/welcome');
}

export function status(): Promise<StatusResponse> {
    return request.get('/status.json');
}
