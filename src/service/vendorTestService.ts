import { SgVendor } from "../model/sgVendor";
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
    const headers = buildHeaders(vendor, requestFormat);
    const body = buildVendorTestBody(requestFormat, model, contentMode);

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
