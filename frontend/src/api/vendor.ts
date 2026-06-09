import request from '../utils/request';
import type { ListResult } from '../types';
import type { Vendor, CreateVendorRequest, UpdateVendorRequest } from '../types/vendor';
import type { VendorQuery } from '../types/vendor';

export interface VendorTestResponse {
    success: boolean;
    status?: number;
    duration?: number;
    url?: string;
    response?: unknown;
    error?: unknown;
}

export async function listVendors(params?: VendorQuery): Promise<ListResult<Vendor>> {
    return request.get('/vendor/list.json', { params });
}

export async function fetchVendorsByIds(ids: number[]): Promise<Vendor[]> {
    return request.post('/vendor/batch.json', { ids });
}

export async function getVendor(id: number): Promise<Vendor> {
    return request.get(`/vendor/${id}`);
}

export async function createVendor(data: CreateVendorRequest): Promise<Vendor> {
    return request.post('/vendor/create.json', data);
}

export async function updateVendor(id: number, data: UpdateVendorRequest): Promise<Vendor> {
    return request.put(`/vendor/${id}`, data);
}

export async function deleteVendor(id: number): Promise<{ success: boolean }> {
    return request.delete(`/vendor/${id}`);
}

export async function listVendorModels(vendorId: number): Promise<import('../types/vendor').VendorModel[]> {
    return request.get(`/vendor/${vendorId}/model/list.json`);
}

export async function fetchVendorModelsByIds(ids: number[]): Promise<import('../types/vendor').VendorModel[]> {
    return request.post('/vendor-model/batch.json', { ids });
}

export async function fetchVendorModels(vendorId: number): Promise<{ models: string[] }> {
    return request.get(`/vendor/${vendorId}/model/fetch.json`);
}

export async function syncVendorModels(vendorId: number, modelIds: string[]): Promise<import('../types/vendor').VendorModel[]> {
    return request.post(`/vendor/${vendorId}/model/sync.json`, { model_ids: modelIds });
}

export async function addVendorModel(vendorId: number, modelId: string): Promise<import('../types/vendor').VendorModel> {
    return request.post(`/vendor/${vendorId}/model/add.json`, { model_id: modelId });
}

export async function deleteVendorModel(vendorId: number, id: number): Promise<{ success: boolean }> {
    return request.delete(`/vendor/${vendorId}/model/${id}`);
}

export async function testVendor(
    id: number,
    format: string = 'openai',
    model?: string,
): Promise<VendorTestResponse> {
    return request.post(`/vendor/${id}/test.json`, { format, model });
}
