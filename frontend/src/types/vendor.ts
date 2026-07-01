import type { BaseEntity, TableQuery } from './index';

export type VendorType = 'openai' | 'anthropic' | 'google' | 'aliyun' | 'aliyun_coding' | 'volcengine_coding' | 'deepseek' | 'mimo' | 'mimo_token_plan' | 'opencode_go' | 'other';

export type VendorAuthMode = 'api_key' | 'bearer_token';

export interface VendorUrls {
    [key: string]: string;
}

export interface Vendor extends BaseEntity {
    type: VendorType;
    name: string;
    token: string;
    urls: VendorUrls;
    auth_mode: VendorAuthMode;
    model_count: number;
}

export interface CreateVendorRequest {
    type: VendorType;
    name: string;
    token: string;
    urls?: VendorUrls;
    auth_mode?: VendorAuthMode;
}

export interface UpdateVendorRequest {
    type?: VendorType;
    name?: string;
    token?: string;
    urls?: VendorUrls;
    auth_mode?: VendorAuthMode;
}

export interface VendorQuery extends TableQuery {
    type?: VendorType;
}

export interface VendorModel {
    id: number;
    vendor_id: number;
    model_id: string;
    allowed_formats: string[] | null;
    created_at: string;
    updated_at: string;
}
