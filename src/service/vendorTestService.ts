import { SgVendor } from "../model/sgVendor";
import type { SgUser } from "../model/sgUser";
import type { SgModel } from "../model/sgModel";
import type { TenantScope } from "./tenantService";
import ruleService from "./ruleService";
import pluginService from "./pluginService";
import hostService from "./hostService";
import { resolveUpstreamFormat } from "../util/protocolUtil/protocolUtil";
import fetchUtil from "../util/fetchUtil";
import abortTimeoutUtil from "../util/abortTimeoutUtil";
import { ApiFormat, VendorAuthMode } from "../constants";
import { buildVendorTestBody, normalizeContentMode, type TestContentMode } from "../util/protocol/testRequestUtil";


export interface TestVendorOptions {
    format?: ApiFormat;
    model?: string;
    auto_convert?: boolean;
    content_mode?: TestContentMode;
    /**
     * 调用方身份（#392）：传入后测试请求会走与真实代理请求同一套**请求插件链**
     * （`ruleService.matchPluginRules` + `pluginService.applyRequestPlugins`）。
     * 不传时行为与旧版完全一致（只有鉴权头），供内部/无用户上下文的调用方使用。
     */
    pluginContext?: { user: SgUser; scope: TenantScope };
}

export interface TestVendorResult {
    success: boolean;
    status?: number;
    duration?: number;
    url: string | null;
    converted_from?: string;
    converted_to?: string;
    proxy?: { type: string; url: string };
    request_method: string;
    request_headers: Record<string, string>;
    request_body: unknown;
    response?: unknown;
    error?: string;
    content_mode: TestContentMode;
}


/**
 * 按 API 格式构建请求头（鉴权逻辑与旧 buildRequest 一致）。
 * 请求体已抽到 util/protocol/testRequestUtil（文本/多模态共用同一套三协议构造）。
 */
function buildHeaders(vendor: SgVendor, format: ApiFormat): Headers {
    const headers = new Headers();

    if (format === ApiFormat.ANTHROPIC) {
        if (vendor.config.auth_mode === VendorAuthMode.BEARER_TOKEN) {
            headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        } else {
            headers.set("x-api-key", vendor.token);
            headers.set("anthropic-version", "2023-06-01");
        }
    } else {
        headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
    }
    headers.set("Content-Type", "application/json");

    return headers;
}


/**
 * 对请求头中的敏感字段进行脱敏
 */
function sanitizeHeaders(headers: Headers): Record<string, string> {
    const entries = Array.from(headers.entries()).map(([key, value]) => {
        if (key.toLowerCase() === "authorization" || key.toLowerCase() === "x-api-key") {
            const visible = value.length > 12 ? value.slice(0, 8) + "****" + value.slice(-4) : "****";
            return [key, visible];
        }
        return [key, value];
    });
    return Object.fromEntries(entries);
}


/**
 * 测试厂商连通性：向上游 API 发送 ping 请求并返回结果
 */
export async function testVendorConnectivity(
    vendor: SgVendor,
    options: TestVendorOptions = {},
): Promise<TestVendorResult> {
    const {
        format: rawFormat = ApiFormat.OPENAI,
        model = "test-ping",
        auto_convert = false,
    } = options;
    // 缺省走文本模式：旧调用方不传 content_mode 时接口行为完全不变
    const contentMode: TestContentMode = normalizeContentMode(options.content_mode);

    let requestFormat: ApiFormat = rawFormat;
    let convertedFrom: string | undefined;
    let convertedTo: string | undefined;

    if (auto_convert) {
        const upstreamFormat = resolveUpstreamFormat(rawFormat, vendor.getSupportedFormats());
        if (upstreamFormat !== rawFormat) {
            convertedFrom = rawFormat;
            convertedTo = upstreamFormat;
            requestFormat = upstreamFormat;
        }
    }

    const url = vendor.getUrlByFormat(requestFormat);
    // auto_convert 时按**最终上游协议**原生构造：多模态不会被协议转换丢掉
    let headers = buildHeaders(vendor, requestFormat);
    let body = buildVendorTestBody(requestFormat, model, contentMode);

    // #392：测试入口也要走与真实请求同一套插件链。
    // 原来这里只 buildHeaders + 裸 fetch，插件链被整段绕过——「自动生成 session header」等插件
    // 对网页「测试」静默失效（实测：开关开着，上游仍收到无 session 头的请求 ⇒ MissingSessionID）。
    // 供应商连通性测试没有模型上下文，用 id=0 的占位模型：依赖 model_id 的规则不命中，
    // 用户 / 租户 / 全局规则与真实请求一致。
    if (options.pluginContext) {
        const { user, scope } = options.pluginContext;
        const matchedRules = await ruleService.matchPluginRules(
            user,
            { id: 0 } as unknown as SgModel,
            vendor,
            scope,
        );
        if (matchedRules.length > 0) {
            // 测试请求没有协议转换阶段，故只跑 before_conversion（与真实请求 clientFormat==upstreamFormat 时的首个阶段一致）
            const applied = await pluginService.applyRequestPlugins({
                hook: "before_conversion",
                body,
                headers,
                matchedRules,
                context: {
                    clientModel: model,
                    clientFormat: requestFormat,
                    upstreamFormat: requestFormat,
                    currentFormat: requestFormat,
                    hostKey: await hostService.getHostKey(),
                    clientName: user.name,
                    userId: Number(user.id),
                },
            });
            body = applied.body;
            headers = applied.headers;
        }
    }

    // 代理信息：原样返回存储的配置
    const proxyConfig = vendor.config.proxy;
    const proxyInfo = proxyConfig
        ? { type: proxyConfig.type, url: proxyConfig.url }
        : undefined;

    let requestBodyDisplay: unknown = body;
    try {
        requestBodyDisplay = JSON.parse(body);
    } catch {}

    if (url === null) {
        return {
            success: false,
            error: `vendor does not have url for ${requestFormat} format`,
            url: null,
            proxy: proxyInfo,
            request_method: "POST",
            request_headers: sanitizeHeaders(headers),
            request_body: requestBodyDisplay,
            content_mode: contentMode,
        };
    }

    try {
        const proxyLog = proxyInfo ? ` via ${proxyInfo.type} proxy ${proxyInfo.url}` : "";
        console.log(`[testVendor] Testing vendor ${vendor.name} (${vendor.id}) with model ${model} at ${url}${proxyLog}`);
        const startTime = Date.now();
        const dispatcher = await fetchUtil.getDispatcher(vendor.config);
        const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            ...(dispatcher ? { dispatcher } : {}),
        });
        const duration = Date.now() - startTime;
        const responseText = await response.text();
        let responseData: unknown;
        try {
            responseData = JSON.parse(responseText);
        } catch {
            responseData = responseText;
        }

        return {
            success: response.ok,
            status: response.status,
            duration,
            url,
            converted_from: convertedFrom,
            converted_to: convertedTo,
            proxy: proxyInfo,
            request_method: "POST",
            request_headers: sanitizeHeaders(headers),
            request_body: requestBodyDisplay,
            response: responseData,
            content_mode: contentMode,
        };
    } catch (error) {
        console.error(`[testVendor] Fetch failed for vendor ${vendor.name} (${vendor.id}) at ${url}:`, error);

        return {
            success: false,
            error: abortTimeoutUtil.describeError(error),
            url,
            proxy: proxyInfo,
            request_method: "POST",
            request_headers: sanitizeHeaders(headers),
            request_body: requestBodyDisplay,
            content_mode: contentMode,
        };
    }
}


export default {
    testVendorConnectivity,
};
