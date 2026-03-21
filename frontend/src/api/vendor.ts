import request from '../utils/request';
import type { Vendor, CreateVendorRequest, UpdateVendorRequest } from '../types/vendor';
import type { VendorQuery } from '../types/vendor';

export async function listVendors(params?: VendorQuery): Promise<Vendor[]> {
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

export async function testVendor(
    id: number,
    format: string = 'openai',
    model?: string,
): Promise<Record<string, unknown>> {
    return request.post(`/vendor/${id}/test.json`, { format, model });
}
