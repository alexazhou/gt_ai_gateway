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
        // RESPONSES 客户端回退优先 OPENAI：Responses 为 OpenAI 原生协议，
        // 转 openai 更贴近原始请求语义（reasoning 映射为 reasoning_effort）
        [ApiFormat.RESPONSES]: [ApiFormat.OPENAI, ApiFormat.ANTHROPIC],
    };

    for (const fmt of supportedAlternativeFormats[clientFormat] ?? []) {
        if (supportedFormats.includes(fmt)) return fmt;
    }

    // 如果没有找到支持的格式，返回客户端请求的格式
    return clientFormat;
}

export default {
    resolveUpstreamFormat,
};
