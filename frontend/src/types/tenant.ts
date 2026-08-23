export interface Tenant {
    id: number;
    name: string;
    description?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface CreateTenantRequest {
    name: string;
    description?: string | null;
}
