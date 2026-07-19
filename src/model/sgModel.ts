import { CastsAttributes, Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { ModelRoutingMode } from "../constants";

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

// @ts-expect-error Sutando .d.ts 声明 static get/set() 无参，运行时传 4 个实参
class ModelRoutingConfig extends CastsAttributes {
    upstreams: ModelUpstreamConfig[] = [];

    constructor(data?: { upstreams?: Array<ModelUpstreamConfig | Partial<ModelUpstreamConfig>> }) {
        super();
        if (Array.isArray(data?.upstreams)) {
            this.upstreams = data.upstreams.map(upstream => (
                upstream instanceof ModelUpstreamConfig
                    ? upstream
                    : new ModelUpstreamConfig(upstream)
            ));
        }
    }

    toJSON() {
        return {
            upstreams: this.upstreams.map(upstream => upstream.toJSON()),
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
        value: ModelRoutingConfig | { upstreams?: Array<Partial<ModelUpstreamConfig>> },
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
    vendor_id!: number | null;
    vendor_model_id!: number | null;
    enable!: boolean;
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

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgModel, ModelRoutingConfig, ModelUpstreamConfig };
