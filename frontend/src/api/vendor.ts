import request from '../utils/request';
import type { ListResult } from '../types';
import type { Vendor, CreateVendorRequest, UpdateVendorRequest } from '../types/vendor';
import type { VendorQuery } from '../types/vendor';

// 测试请求的内容模式：text=纯文本；image=多模态（后端内置样图，前端只传模式）
export type TestContentMode = 'text' | 'image';

export interface VendorTestResponse {
    success: boolean;
    status?: number;
    duration?: number;
    url?: string;
    converted_from?: string;
    converted_to?: string;
    proxy?: { type: string; url: string };
    request_method?: string;
    request_headers?: Record<string, string>;
    request_body?: unknown;
    response?: unknown;
    error?: unknown;
    // 后端回显本次实际使用的模式（旧后端不返回该字段，故可选）
    content_mode?: TestContentMode;
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

export async function updateVendorModel(vendorId: number, id: number, allowedFormats: string[] | null): Promise<import('../types/vendor').VendorModel> {
    return request.put(`/vendor/${vendorId}/model/${id}`, { allowed_formats: allowedFormats });
}

export async function deleteVendorModel(vendorId: number, id: number): Promise<{ success: boolean }> {
    return request.delete(`/vendor/${vendorId}/model/${id}`);
}

export async function getVendorPresetUrls(): Promise<Record<string, Record<string, string>>> {
    return request.get('/vendor/preset-urls.json');
}


export async function testVendor(
    id: number,
    format: string = 'openai',
    model?: string,
    autoConvert: boolean = false,
    contentMode: TestContentMode = 'text',
): Promise<VendorTestResponse> {
    return request.post(`/vendor/${id}/test.json`, {
        format,
        model,
        auto_convert: autoConvert,
        content_mode: contentMode,
    });
}
