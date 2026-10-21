import { ApiFormat } from "../../constants";


/**
 * 上游在响应体里报告的失败。code 为上游错误码/错误类别，取不到时为 null。
 */
export interface UpstreamBodyFailure {
    code: string | null;
}


function parseBody(responseText: string): Record<string, any> | null {
    let json: any;
    try {
        json = JSON.parse(responseText);
    } catch {
        return null;
    }
    if (!json || typeof json !== "object") {
        return null;
    }
    return json;
}


function stringOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}


/**
 * Responses：非流式返回体是 response 对象，失败终态为 status:"failed"（错误详情在 error 里）。
 * 注意 status:"incomplete"（被 max_output_tokens 等截断）是被截断的正常返回，不算失败。
 * 部分兼容上游直接回传错误事件体 {type:"error", code, message}，一并认掉。
 */
function detectResponses(json: Record<string, any>): UpstreamBodyFailure | null {
    if (json.status === "failed") {
        return { code: stringOrNull(json.error?.code) };
    }
    if (json.type === "error") {
        return { code: stringOrNull(json.code) };
    }
    return null;
}


/**
 * OpenAI：错误体为 {error:{message,type,code,param}}。
 * 用 != null 判定——上游正常响应里带显式 error:null 的情况不算失败。
 */
function detectOpenAI(json: Record<string, any>): UpstreamBodyFailure | null {
    if (json.error != null) {
        return { code: stringOrNull(json.error.code) ?? stringOrNull(json.error.type) };
    }
    return null;
}


/**
 * Anthropic：错误体为 {type:"error", error:{type,message}}，没有 code 字段，
 * 错误类别在 error.type 里（overloaded_error / rate_limit_error 等），因此取 error.type 作为码。
 */
function detectAnthropic(json: Record<string, any>): UpstreamBodyFailure | null {
    if (json.type === "error" || json.error != null) {
        return { code: stringOrNull(json.error?.type) ?? stringOrNull(json.error?.code) };
    }
    return null;
}


/**
 * 判断响应体里是否带着上游的失败标记：是则返回失败描述，否则返回 null。
 * 上游可能把失败放进 HTTP 200 的响应体里（而不是用非 2xx 状态码），只看状态码会把这类失败
 * 记成成功，因此按 upstreamFormat 分发到各协议自己的失败形态判定。
 * 响应体无法解析成 JSON 时返回 null，交给正常路径处理。
 */
export function detectUpstreamBodyFailure(
    format: ApiFormat,
    responseText: string,
): UpstreamBodyFailure | null {
    const json = parseBody(responseText);
    if (!json) {
        return null;
    }

    if (format === ApiFormat.RESPONSES) {
        return detectResponses(json);
    }
    if (format === ApiFormat.ANTHROPIC) {
        return detectAnthropic(json);
    }
    return detectOpenAI(json);
}


export default {
    detectUpstreamBodyFailure,
};
