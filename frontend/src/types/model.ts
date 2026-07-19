import type { BaseEntity, TableQuery } from './index';

export type ModelRoutingMode = 'single' | 'load_balance' | 'failover';

export interface ModelUpstreamConfig {
    vendor_id: number;
    vendor_model_id?: number;
    enabled: boolean;
}

export interface ModelRoutingConfig {
    upstreams: ModelUpstreamConfig[];
}

export interface Model extends BaseEntity {
    name: string;
    vendor_id: number;
    vendor_model_id: number | null;
    routing_mode: ModelRoutingMode;
    routing_config: ModelRoutingConfig;
    enable: boolean;
    prices?: {
        input?: number;
        output?: number;
        cache_read?: number;
    } | null;
}

export interface CreateModelRequest {
    name: string;
    vendor_id?: number;
    enable?: boolean;
    prices?: {
        input?: number;
        output?: number;
        cache_read?: number;
    } | null;
    vendor_model_id?: number | null;
    routing_mode?: ModelRoutingMode;
    routing_config?: ModelRoutingConfig;
}

export interface UpdateModelRequest {
    name?: string;
    vendor_id?: number;
    enable?: boolean;
    prices?: {
        input?: number;
        output?: number;
        cache_read?: number;
    } | null;
    vendor_model_id?: number | null;
    routing_mode?: ModelRoutingMode;
    routing_config?: ModelRoutingConfig;
}

export interface ModelQuery extends TableQuery {
    vendor_id?: number;
}
