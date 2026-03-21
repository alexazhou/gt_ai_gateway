import request from '../utils/request';
import type { Model, CreateModelRequest, UpdateModelRequest } from '../types/model';
import type { ModelQuery } from '../types/model';

export async function listModels(params?: ModelQuery): Promise<Model[]> {
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
