import { Model } from "sutando";
import { CastsAttributes } from "sutando";
import { inspect, InspectOptions } from "util";
import { ApiFormat, VendorAuthMode } from "../constants";
import vendorDefaultUrls from "../util/vendorDefaultUrlsUtil";
import urlUtil from "../util/protocol/urlUtil";


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
    type!: string;
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

    constructor(attributes: Record<string, unknown> = {}) {
        super();
        this.fill({
            urls: {},
            config: new SgVendorConfig(),
            ...attributes,
        });
    }

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
     * @returns 完整的 URL 字符串；无法解析（缺 URL 或无法派生）时返回 null，由调用方处理
     */
    getUrlByFormat(format: ApiFormat): string | null {
        const urls = this.getMergedUrls();

        if (format === ApiFormat.RESPONSES) {
            // Responses 格式：优先使用 urls[RESPONSES]
            const responsesUrl = urls[ApiFormat.RESPONSES];
            if (responsesUrl) {
                return responsesUrl.includes("/responses") ? responsesUrl : responsesUrl.replace(/\/$/, "") + "/responses";
            }
            // 没有 urls[RESPONSES]，从 OPENAI URL 派生；非标准 openai URL 无法派生时返回 null
            const openaiUrl = this.getUrlByFormat(ApiFormat.OPENAI);
            if (openaiUrl === null) {
                return null;
            }
            return urlUtil.convertOpenaiToResponses(openaiUrl);
        }

        if (format === ApiFormat.ANTHROPIC) {
            // Anthropic 格式：使用 urls[ANTHROPIC]
            const anthropicUrl = urls[ApiFormat.ANTHROPIC];
            if (anthropicUrl) {
                return anthropicUrl.includes("/v1/messages") ? anthropicUrl : anthropicUrl.replace(/\/$/, "") + "/v1/messages";
            }
        }

        if (format === ApiFormat.OPENAI) {
            // OpenAI 格式：使用 urls[OPENAI]
            const openaiUrl = urls[ApiFormat.OPENAI];
            if (openaiUrl) {
                return openaiUrl.includes("/chat/completions") ? openaiUrl : openaiUrl.replace(/\/$/, "") + "/chat/completions";
            }
        }

        return null;
    }

    /**
     * 获取当前 vendor 支持的格式列表
     * 口径与 getUrlByFormat 完全一致：能拿到某格式的 URL（含自动补全后缀后的派生）即视为支持，
     * 避免「getUrlByFormat 能解析但 getSupportedFormats 不认可」的不一致。
     * @returns 支持的格式数组
     */
    getSupportedFormats(): ApiFormat[] {
        const formats: ApiFormat[] = [];

        if (this.getUrlByFormat(ApiFormat.OPENAI) !== null) {
            formats.push(ApiFormat.OPENAI);
        }
        if (this.getUrlByFormat(ApiFormat.ANTHROPIC) !== null) {
            formats.push(ApiFormat.ANTHROPIC);
        }
        if (this.getUrlByFormat(ApiFormat.RESPONSES) !== null) {
            formats.push(ApiFormat.RESPONSES);
        }

        return formats;
    }

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgVendor, SgVendorConfig };
