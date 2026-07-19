import type { BaseEntity, TableQuery } from './index';

export type ModelRoutingMode = 'single' | 'load_balance' | 'failover';

export interface ModelUpstreamConfig {
    vendor_id: number;
    vendor_model_id?: number;
    enabled: boolean;
}

export interface ModelUpstreamFormValue {
    vendor_id?: number;
    vendor_model_id?: number;
    enabled: boolean;
}

export interface ModelRoutingConfig {
    upstreams: ModelUpstreamConfig[];
}

export interface Model extends BaseEntity {
    name: string;
    routing_mode: ModelRoutingMode;
    routing_config: ModelRoutingConfig;
    enable: boolean;
    prices?: {
        input?: number;
        output?: number;
        cache_read?: number;
    } | null;
}

export type CreateModelRequest = Pick<
    Model,
    'name' | 'enable' | 'prices' | 'routing_mode' | 'routing_config'
>;

export type UpdateModelRequest = CreateModelRequest;

export interface ModelQuery extends TableQuery {
    vendor_id?: number;
}
