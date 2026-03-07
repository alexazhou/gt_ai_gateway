import request from '@/utils/request';
import type { Vendor, CreateVendorRequest, UpdateVendorRequest, VendorQuery } from '@/types/vendor';

export function listVendors(query?: VendorQuery): Promise<Vendor[]> {
    return request.get('/vendor/list.json', { params: query });
}

export function getVendor(id: number): Promise<Vendor> {
    return request.get(`/vendor/${id}`);
}

export function createVendor(data: CreateVendorRequest): Promise<Vendor> {
    return request.post('/vendor/create.json', data);
}

export function updateVendor(id: number, data: UpdateVendorRequest): Promise<Vendor> {
    return request.put(`/vendor/${id}`, data);
}

export function deleteVendor(id: number): Promise<void> {
    return request.delete(`/vendor/${id}`);
}
