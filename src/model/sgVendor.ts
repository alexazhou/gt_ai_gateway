import { Model } from "sutando";
import { CastsAttributes } from "sutando";
import { inspect, InspectOptions } from "util";
import { VendorType, ApiFormat, VendorAuthMode } from "../constants";
import vendorDefaultUrls from "../service/vendorDefaultUrls";
import customError from "../util/customError";
import urlUtil from "../util/urlUtil";


/**
 * 供应商配置对象，同时作为 Sutando 自定义 cast（Sutando 通过 instanceof CastsAttributes 识别）。
 * vendor.config 的类型即为此类，读写一致。
 */
// @ts-expect-error Sutando .d.ts 声明 static get/set() 无参，运行时传 4 个实参
class SgVendorConfig extends CastsAttributes {
    /** 认证模式，未配置时默认为 bearer_token */
    auth_mode: VendorAuthMode = VendorAuthMode.BEARER_TOKEN;

    /** 是否跳过 TLS 证书验证（用于自签证书等内网环境） */
    skip_tls_verify: boolean = false;

    /** 代理配置 */
    proxy?: { type: "http" | "socks5"; url: string } | null;

    constructor(data?: Partial<SgVendorConfig>) {
        super();
        if (data) {
            if (data.auth_mode !== undefined) this.auth_mode = data.auth_mode;
            if (data.skip_tls_verify !== undefined) this.skip_tls_verify = data.skip_tls_verify;
            if (data.proxy !== undefined) this.proxy = data.proxy;
        }
    }

    /** API 响应序列化（JSON.stringify 自动调用） */
    toJSON() {
        const result: Record<string, any> = {
            auth_mode: this.auth_mode,
            skip_tls_verify: this.skip_tls_verify,
        };
        if (this.proxy != null) result.proxy = this.proxy;
        return result;
    }

    // ---- Sutando custom cast ----

    /** DB string → SgVendorConfig 实例 */
    static get(self: SgVendor, key: string, value: string): SgVendorConfig {
        let parsed: Record<string, any> = {};
        try { parsed = value ? JSON.parse(value) : {}; } catch {}
        return new SgVendorConfig(parsed);
    }

    // 创建时收到纯对象，读改保存时收到 SgVendorConfig 实例，两者都需支持
    static set(self: SgVendor, key: string, value: SgVendorConfig | Record<string, any>): string {
        return JSON.stringify(value instanceof SgVendorConfig ? value.toJSON() : value);
    }
}

class SgVendor extends Model {
    table = "vendor";

    id!: number;
    type!: VendorType;
    name!: string;
    token!: string;
    urls!: Record<string, string>;
    config!: SgVendorConfig;

    casts = {
        urls: 'json',
        config: SgVendorConfig,
    };

    created_at!: Date;
    updated_at!: Date;

    /**
     * Merge preset URLs and DB-stored custom URLs.
     * Custom URLs override presets with the same format key.
     */
    getMergedUrls(): Record<string, string> {
        const presetUrls = vendorDefaultUrls.getAllUrls()[this.type] ?? {};
        const merged = { ...presetUrls, ...this.urls };
        delete merged['label'];
        return merged;
    }

    /**
     * 根据 API 格式获取对应的 URL
     * @param format - API 格式（openai, anthropic, responses）
     * @returns 完整的 URL 字符串
     */
    getUrlByFormat(format: ApiFormat): string {
        const urls = this.getMergedUrls();
        let url: string | undefined;

        if (format === ApiFormat.RESPONSES) {
            // Responses 格式：优先使用 urls[RESPONSES]
            if (urls[ApiFormat.RESPONSES]) {
                url = urls[ApiFormat.RESPONSES];
                return url.includes("/responses") ? url : url.replace(/\/$/, "") + "/responses";
            }
            // 没有 urls[RESPONSES]，获取 OPENAI URL 并转换为 RESPONSES 格式
            return urlUtil.convertOpenaiToResponses(this.getUrlByFormat(ApiFormat.OPENAI));
        }

        if (format === ApiFormat.ANTHROPIC) {
            // Anthropic 格式：使用 urls[ANTHROPIC]
            url = urls[ApiFormat.ANTHROPIC];
            if (url) {
                return url.includes("/v1/messages") ? url : url.replace(/\/$/, "") + "/v1/messages";
            }
        }

        if (format === ApiFormat.OPENAI) {
            // OpenAI 格式：使用 urls[OPENAI]
            url = urls[ApiFormat.OPENAI];
            if (url) {
                return url.includes("/chat/completions") ? url : url.replace(/\/$/, "") + "/chat/completions";
            }
        }

        throw new customError.AppError(`vendor does not have url for ${format} format`, 400);
    }

    /**
     * 获取当前 vendor 支持的格式列表
     * @returns 支持的格式数组
     */
    getSupportedFormats(): ApiFormat[] {
        const urls = this.getMergedUrls();
        const formats: ApiFormat[] = [];

        if (urls[ApiFormat.OPENAI]) formats.push(ApiFormat.OPENAI);
        if (urls[ApiFormat.ANTHROPIC]) formats.push(ApiFormat.ANTHROPIC);
        if (urls[ApiFormat.RESPONSES]) formats.push(ApiFormat.RESPONSES);

        return formats;
    }

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgVendor, SgVendorConfig };
