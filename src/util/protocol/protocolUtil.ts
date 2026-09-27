import { ApiFormat } from "../../constants";

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

    // 上游不支持客户端协议时，按下面的顺序回退。
    // OpenAI 与 Responses 是同一家的两套协议，互相转换更贴近原始请求语义
    // （reasoning 映射为 reasoning_effort），所以互为首选，Anthropic 排在后面。
    const supportedAlternativeFormats: Partial<Record<ApiFormat, ApiFormat[]>> = {
        [ApiFormat.OPENAI]: [ApiFormat.RESPONSES, ApiFormat.ANTHROPIC],
        [ApiFormat.ANTHROPIC]: [ApiFormat.OPENAI, ApiFormat.RESPONSES],
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
