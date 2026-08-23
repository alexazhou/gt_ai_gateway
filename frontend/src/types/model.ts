import type { BaseEntity, TableQuery } from './index';

export type ModelRoutingMode = 'single' | 'load_balance' | 'first_available';

export type LoadBalanceStrategy = 'user' | 'request';

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

export interface ModelFailoverConfig {
    enabled: boolean;
}

export interface ModelRoutingConfig {
    upstreams: ModelUpstreamConfig[];
    failover: ModelFailoverConfig;
    load_balance_strategy?: LoadBalanceStrategy;
}

export interface ModelPrices {
    input?: number;
    output?: number;
    cache_read?: number;
}

export interface Model extends BaseEntity {
    name: string;
    routing_mode: ModelRoutingMode;
    routing_config: ModelRoutingConfig;
    enable: boolean;
    prices?: ModelPrices | null;
    /** 归属租户 id（非 main 视角列表可见 main 共享模型时，用于识别只读） */
    tenant_id?: number | null;
    /** 跨租户共享标记：1 = 跨租户共享（仅 main 租户模型可置 1） */
    cross_tenant?: boolean;
}

export type CreateModelRequest = Pick<
    Model,
    'name' | 'enable' | 'prices' | 'routing_mode' | 'routing_config' | 'cross_tenant'
>;

export type UpdateModelRequest = CreateModelRequest;

export interface ModelQuery extends TableQuery {
    vendor_id?: number;
}
