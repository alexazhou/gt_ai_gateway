import request from '../utils/request';
import type { ListResult } from '../types';
import type { Model, CreateModelRequest, UpdateModelRequest } from '../types/model';
import type { ModelQuery } from '../types/model';
import type { VendorTestResponse } from '../api/vendor';

export async function listModels(params?: ModelQuery): Promise<ListResult<Model>> {
    return request.get('/model/list.json', { params });
}

export async function fetchModelsByIds(ids: number[]): Promise<Model[]> {
    return request.post('/model/batch.json', { ids });
}

export async function getModel(id: number): Promise<Model> {
    return request.get(`/model/${id}`);
}

export async function createModel(data: CreateModelRequest): Promise<Model> {
    return request.post('/model/create.json', data);
}

export async function updateModel(id: number, data: UpdateModelRequest): Promise<Model> {
    return request.put(`/model/${id}`, data);
}

export async function deleteModel(id: number): Promise<{ success: boolean }> {
    return request.delete(`/model/${id}`);
}

// 模型路由测试：走真实网关路由 + failover，返回上游实际请求快照与上游响应
export async function testModelRoute(model: string, format: string): Promise<VendorTestResponse> {
    return request.post('/model/route-test.json', { model, format });
}
