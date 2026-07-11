import { SgVendor } from "../model/sgVendor";
import { resolveUpstreamFormat } from "../util/protocolUtils";
import fetchUtil from "../util/fetchUtil";
import { ApiFormat, VendorAuthMode } from "../constants";


export interface TestVendorOptions {
    format?: ApiFormat;
    model?: string;
    auto_convert?: boolean;
}

export interface TestVendorResult {
    success: boolean;
    status?: number;
    duration?: number;
    url: string;
    converted_from?: string;
    converted_to?: string;
    proxy?: { type: string; url: string };
    request_method: string;
    request_headers: Record<string, string>;
    request_body: unknown;
    response?: unknown;
    error?: string;
}


/**
 * 按 API 格式构建请求头和请求体
 */
function buildRequest(
    vendor: SgVendor,
    format: ApiFormat,
    model: string,
): { headers: Headers; body: string } {
    const headers = new Headers();
    let body = "";

    if (format === ApiFormat.ANTHROPIC) {
        if (vendor.config.auth_mode === VendorAuthMode.BEARER_TOKEN) {
            headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        } else {
            headers.set("x-api-key", vendor.token);
            headers.set("anthropic-version", "2023-06-01");
        }
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
        });
    } else if (format === ApiFormat.RESPONSES) {
        headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
            model,
            input: "ping",
            max_output_tokens: 16,
        });
    } else {
        headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 5,
        });
    }

    return { headers, body };
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
    const { headers, body } = buildRequest(vendor, requestFormat, model);

    // 代理信息：原样返回存储的配置
    const proxyConfig = vendor.config.proxy;
    const proxyInfo = proxyConfig
        ? { type: proxyConfig.type, url: proxyConfig.url }
        : undefined;

    let requestBodyDisplay: unknown = body;
    try {
        requestBodyDisplay = JSON.parse(body);
    } catch {}

    try {
        const proxyLog = proxyInfo ? ` via ${proxyInfo.type} proxy ${proxyInfo.url}` : "";
        console.log(`[testVendor] Testing vendor ${vendor.name} (${vendor.id}) with model ${model} at ${url}${proxyLog}`);
        const startTime = Date.now();
        const dispatcher = await fetchUtil.getDispatcher(vendor.config);
        const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            ...(dispatcher ? { dispatcher: dispatcher } as any : {}),
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
        };
    } catch (error: any) {
        console.error(`[testVendor] Fetch failed for vendor ${vendor.name} (${vendor.id}) at ${url}:`, error);

        let errorMessage = error.message || String(error);
        if (error.cause) {
            errorMessage += `\nCause: ${error.cause.message || String(error.cause)}`;
        }

        return {
            success: false,
            error: errorMessage,
            url,
            proxy: proxyInfo,
            request_method: "POST",
            request_headers: sanitizeHeaders(headers),
            request_body: requestBodyDisplay,
        };
    }
}


export default {
    testVendorConnectivity,
};
