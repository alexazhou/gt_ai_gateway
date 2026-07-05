import { ApiFormat } from "../constants";

/**
 * 解析上游支持的格式
 * 根据客户端请求的格式和支持的格式列表，计算最终应该用什么格式
 *
 * @param clientFormat - 客户端请求的格式
 * @param supportedFormats - 支持的格式列表（vendor 或 vendorModel 的）
 * @returns 最终应该使用的格式
 */
export function resolveUpstreamFormat(
    clientFormat: ApiFormat,
    supportedFormats: ApiFormat[],
): ApiFormat {
    // 如果支持客户端格式，直接使用
    if (supportedFormats.includes(clientFormat)) {
        return clientFormat;
    }

    // 尝试其他支持的格式（按优先级排序）
    const supportedAlternativeFormats: Partial<Record<ApiFormat, ApiFormat[]>> = {
        [ApiFormat.OPENAI]: [ApiFormat.ANTHROPIC],
        [ApiFormat.ANTHROPIC]: [ApiFormat.OPENAI, ApiFormat.RESPONSES],
        [ApiFormat.RESPONSES]: [ApiFormat.ANTHROPIC, ApiFormat.OPENAI],
    };

    for (const fmt of supportedAlternativeFormats[clientFormat] ?? []) {
        if (supportedFormats.includes(fmt)) return fmt;
    }

    // 如果没有找到支持的格式，返回客户端请求的格式
    return clientFormat;
}

export function isResponsesOutputStartedEvent(eventType: string): boolean {
    return [
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.function_call_arguments.delta",
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_part.added",
    ].includes(eventType);
}

export default {
    resolveUpstreamFormat,
    isResponsesOutputStartedEvent,
};
