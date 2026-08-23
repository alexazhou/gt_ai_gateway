import { CastsAttributes, Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { ModelRoutingMode, MIN_MODEL_PRICE, PRICE_UNIT_TOKENS } from "../constants";
import customError from "../customError";

class ModelUpstreamConfig {
    vendor_id: number = 0;
    vendor_model_id?: number;
    enabled: boolean = true;

    constructor(data?: Partial<ModelUpstreamConfig>) {
        if (data?.vendor_id !== undefined) this.vendor_id = data.vendor_id;
        if (data?.vendor_model_id !== undefined) this.vendor_model_id = data.vendor_model_id;
        if (data?.enabled !== undefined) this.enabled = data.enabled;
    }

    toJSON() {
        return {
            vendor_id: this.vendor_id,
            ...(this.vendor_model_id !== undefined ? { vendor_model_id: this.vendor_model_id } : {}),
            enabled: this.enabled,
        };
    }
}

class ModelFailoverConfig {
    enabled: boolean = true;

    constructor(data?: Partial<ModelFailoverConfig>) {
        if (data?.enabled !== undefined && typeof data.enabled === "boolean") {
            this.enabled = data.enabled;
        }
    }

    toJSON() {
        return {
            enabled: this.enabled,
        };
    }
}

// @ts-expect-error Sutando .d.ts 声明 static get/set() 无参，运行时传 4 个实参
class ModelRoutingConfig extends CastsAttributes {
    upstreams: ModelUpstreamConfig[] = [];
    failover: ModelFailoverConfig = new ModelFailoverConfig();
    // 负载均衡策略：user = 按用户随机（用户 id 为种子，同用户路由稳定），request = 按请求随机
    load_balance_strategy: "user" | "request" = "user";

    constructor(data?: {
        upstreams?: Array<ModelUpstreamConfig | Partial<ModelUpstreamConfig>>;
        failover?: ModelFailoverConfig | Partial<ModelFailoverConfig>;
        load_balance_strategy?: "user" | "request";
    }) {
        super();
        if (Array.isArray(data?.upstreams)) {
            this.upstreams = data.upstreams.map(upstream => (
                upstream instanceof ModelUpstreamConfig
                    ? upstream
                    : new ModelUpstreamConfig(upstream)
            ));
        }
        if (data?.failover) {
            this.failover = data.failover instanceof ModelFailoverConfig
                ? data.failover
                : new ModelFailoverConfig(data.failover);
        }
        if (data?.load_balance_strategy === "user" || data?.load_balance_strategy === "request") {
            this.load_balance_strategy = data.load_balance_strategy;
        }
    }

    toJSON() {
        return {
            upstreams: this.upstreams.map(upstream => upstream.toJSON()),
            failover: this.failover.toJSON(),
            load_balance_strategy: this.load_balance_strategy,
        };
    }

    static get(self: SgModel, key: string, value: string): ModelRoutingConfig {
        let parsed: Record<string, any> = {};
        try { parsed = value ? JSON.parse(value) : {}; } catch {}
        return new ModelRoutingConfig(parsed);
    }

    static set(
        self: SgModel,
        key: string,
        value: ModelRoutingConfig | {
            upstreams?: Array<Partial<ModelUpstreamConfig>>;
            failover?: Partial<ModelFailoverConfig>;
            load_balance_strategy?: "user" | "request";
        },
    ): string {
        const config = value instanceof ModelRoutingConfig
            ? value
            : new ModelRoutingConfig(value);
        return JSON.stringify(config.toJSON());
    }
}

class SgModel extends Model {
    table = "model";

    id!: number;

    name!: string | null;
    enable!: boolean;
    /** 归属租户（回填后应用层强制非空） */
    tenant_id!: number | null;
    /** 全局共享标记：1 = 对所有租户可见；0 = 租户私有。仅 main 租户下的模型可置 1 */
    cross_tenant!: boolean;
    prices!: { input?: number, output?: number, cache_read?: number } | null;
    routing_mode!: ModelRoutingMode;
    routing_config!: ModelRoutingConfig;

    casts = {
        prices: "json",
        routing_config: ModelRoutingConfig,
    };

    created_at!: Date;
    updated_at!: Date;

    constructor(attributes: Record<string, unknown> = {}) {
        super();
        this.fill({
            enable: true,
            prices: {},
            ...attributes,
        });
    }


    getRoutingConfig(): ModelRoutingConfig {
        return this.routing_config ?? new ModelRoutingConfig();
    }

    // 价格单位为每百万 token；价格允许 0（免费）或 >= MIN_MODEL_PRICE，其余值拒绝
    validatePrices(): void {
        const prices = this.prices;
        if (!prices) {
            return;
        }
        for (const [key, value] of Object.entries(prices)) {
            if (value === undefined || value === null) {
                continue;
            }
            if (
                typeof value !== "number"
                || !Number.isFinite(value)
                || value < 0
                || (value > 0 && value < MIN_MODEL_PRICE)
            ) {
                throw new customError.AppError(
                    `Price "${key}" must be 0 (free) or >= ${MIN_MODEL_PRICE} (per ${PRICE_UNIT_TOKENS} tokens)`,
                    400,
                );
            }
        }
    }

    // 是否启用计费：任一价格字段 > 0 视为计费；未设置或全部为 0 视为免费
    hasBilling(): boolean {
        const prices = this.prices;
        if (!prices) {
            return false;
        }
        return Object.values(prices).some(value => typeof value === "number" && value > 0);
    }

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgModel, ModelRoutingConfig, ModelUpstreamConfig, ModelFailoverConfig };
