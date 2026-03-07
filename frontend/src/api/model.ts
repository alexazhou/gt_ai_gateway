import request from '@/utils/request';
import type { Model, CreateModelRequest, UpdateModelRequest, ModelQuery } from '@/types/model';

export function listModels(query?: ModelQuery): Promise<Model[]> {
    return request.get('/model/list.json', { params: query });
}

export function getModel(id: number): Promise<Model> {
    return request.get(`/model/${id}`);
}

export function createModel(data: CreateModelRequest): Promise<Model> {
    return request.post('/model/create.json', data);
}

export function updateModel(id: number, data: UpdateModelRequest): Promise<Model> {
    return request.put(`/model/${id}`, data);
}

export function deleteModel(id: number): Promise<void> {
    return request.delete(`/model/${id}`);
}
