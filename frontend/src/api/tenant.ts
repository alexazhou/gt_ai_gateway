import request from '../utils/request';
import type { ListResponse } from '../types';
import type { Tenant, CreateTenantRequest } from '../types/tenant';

export async function listTenants(params?: { keyword?: string; pageSize?: number; offset?: number }): Promise<ListResponse<Tenant>> {
    return request.get('/tenant.json', { params });
}

export async function createTenant(data: CreateTenantRequest): Promise<Tenant> {
    return request.post('/tenant.json', data);
}

export async function updateTenant(id: number, data: Partial<CreateTenantRequest>): Promise<Tenant> {
    return request.put(`/tenant/${id}`, data);
}

export async function deleteTenant(id: number): Promise<{ success: boolean }> {
    return request.delete(`/tenant/${id}`);
}
