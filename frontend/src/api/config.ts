import request from '../utils/request';
import type { ConfigMap, UpdateConfigRequest } from '../types/config';

export async function getConfig(): Promise<ConfigMap> {
    return request.get('/config.json');
}

export async function updateConfig(data: UpdateConfigRequest): Promise<ConfigMap> {
    return request.put('/config.json', data);
}
