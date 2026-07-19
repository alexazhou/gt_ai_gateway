import { CastsAttributes, Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { ApiFormat } from "../constants";

class VendorModelProtocolHealth {
    last_failure_at: string | null = null;

    constructor(data?: Partial<VendorModelProtocolHealth>) {
        if (data?.last_failure_at !== undefined) this.last_failure_at = data.last_failure_at;
    }

    toJSON() {
        return {
            last_failure_at: this.last_failure_at,
        };
    }
}

type VendorModelHealthData = Partial<Record<
    ApiFormat,
    VendorModelProtocolHealth | Partial<VendorModelProtocolHealth>
>>;

// @ts-expect-error Sutando .d.ts 声明 static get/set() 无参，运行时传 4 个实参
class VendorModelHealth extends CastsAttributes {
    private protocols: Partial<Record<ApiFormat, VendorModelProtocolHealth>> = {};

    constructor(data?: VendorModelHealthData) {
        super();
        for (const format of Object.values(ApiFormat)) {
            const protocolHealth = data?.[format];
            if (protocolHealth) {
                this.protocols[format] = protocolHealth instanceof VendorModelProtocolHealth
                    ? protocolHealth
                    : new VendorModelProtocolHealth(protocolHealth);
            }
        }
    }

    getProtocolHealth(format: ApiFormat): VendorModelProtocolHealth | null {
        return this.protocols[format] ?? null;
    }

    getLastFailureAt(format: ApiFormat): string | null {
        return this.getProtocolHealth(format)?.last_failure_at ?? null;
    }

    recordFailure(format: ApiFormat, failedAt: Date): void {
        this.protocols[format] = new VendorModelProtocolHealth({
            last_failure_at: failedAt.toISOString(),
        });
    }

    toJSON(): Record<string, ReturnType<VendorModelProtocolHealth["toJSON"]>> {
        const result: Record<string, ReturnType<VendorModelProtocolHealth["toJSON"]>> = {};
        for (const [format, protocolHealth] of Object.entries(this.protocols)) {
            if (protocolHealth) result[format] = protocolHealth.toJSON();
        }
        return result;
    }

    static get(self: SgVendorModel, key: string, value: string): VendorModelHealth {
        let parsed: VendorModelHealthData = {};
        try { parsed = value ? JSON.parse(value) : {}; } catch {}
        return new VendorModelHealth(parsed);
    }

    static set(
        self: SgVendorModel,
        key: string,
        value: VendorModelHealth | VendorModelHealthData,
    ): string {
        const health = value instanceof VendorModelHealth
            ? value
            : new VendorModelHealth(value);
        return JSON.stringify(health.toJSON());
    }
}

class SgVendorModel extends Model {
    table = "vendor_model";

    id!: number;
    vendor_id!: number;
    model_id!: string;
    allowed_formats!: string | null;
    health!: VendorModelHealth;

    casts = {
        health: VendorModelHealth,
    };

    created_at!: Date;
    updated_at!: Date;

    getAllowedFormats(): ApiFormat[] | null {
        if (!this.allowed_formats) return null;
        try { return JSON.parse(this.allowed_formats) as ApiFormat[]; } catch { return null; }
    }

    /**
     * 获取当前 vendorModel 支持的格式列表
     * @returns 支持的格式数组，未配置时返回 null 表示无限制
     */
    getSupportedFormats(): ApiFormat[] | null {
        return this.getAllowedFormats();
    }

    getHealth(): VendorModelHealth {
        return this.health ?? new VendorModelHealth();
    }

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgVendorModel, VendorModelHealth, VendorModelProtocolHealth };
