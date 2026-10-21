import customError from "../../customError";
import objectUtil from "../objectUtil";
import type { AnthropicContentBlock, AnthropicRequest } from "../protocol/anthropicTypes";
import type { ResponsesContentPart } from "../protocol/responsesTypes";

/**
 * 追加 Anthropic 消息。
 * 连续 user 消息合并为一条：工具结果后紧跟普通 user 内容时，
 * 不应产生连续的 user turn 依赖上游自动合并。
 */
function appendAnthropicMessage(
    messages: AnthropicRequest["messages"],
    role: "user" | "assistant",
    content: string | AnthropicContentBlock[],
): void {
    const last = messages[messages.length - 1];
    if (role === "user" && last?.role === "user") {
        const lastBlocks: AnthropicContentBlock[] = typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : last.content;
        const newBlocks: AnthropicContentBlock[] = typeof content === "string"
            ? [{ type: "text", text: content }]
            : content;
        last.content = [...lastBlocks, ...newBlocks];
        return;
    }
    messages.push({ role, content });
}


/**
 * 解析工具调用的 JSON 参数；非法 JSON 或非对象结果时返回空对象。
 */
function parseToolArguments(args: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(args);
        return objectUtil.isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}


/**
 * Responses 内容块 → 纯文本（system / assistant 消息只承载文本）。
 * input_file 无法转换时明确报错，避免静默丢失。
 */
function extractResponsesText(
    content: string | ResponsesContentPart[],
    target: "Anthropic" | "OpenAI",
): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const texts: string[] = [];
    for (const part of content) {
        if (part.type === "input_text" || part.type === "output_text") {
            texts.push(part.text);
        } else if (part.type === "input_file") {
            throw new customError.AppError(
                `Responses input_file cannot be converted to ${target}`,
                400,
            );
        }
    }
    return texts.join("\n");
}


/**
 * Anthropic image source → 可用的图片 URL（base64 data URL 或远程 URL）。
 * 无法构造有效地址时明确报错，避免静默丢图。
 */
function anthropicImageSourceToUrl(source: AnthropicContentBlock["source"] | undefined): string {
    if (source?.type === "base64" && source.data) {
        return `data:${source.media_type || "image/png"};base64,${source.data}`;
    }
    if (source?.type === "url" && source.url) {
        return source.url;
    }
    throw new customError.AppError(
        "Anthropic image block requires a valid source (base64 data or url) for protocol conversion",
        400,
    );
}

/**
 * 图片 URL → Anthropic image source。
 * base64 data URL 拆成 base64 source，其余按远程 URL 透传。
 */
function anthropicImageSourceFromUrl(url: string): NonNullable<AnthropicContentBlock["source"]> {
    const dataUrlMatch = url.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (dataUrlMatch) {
        return {
            type: "base64",
            media_type: dataUrlMatch[1],
            data: dataUrlMatch[2],
        };
    }
    if (url.startsWith("data:")) {
        throw new customError.AppError(
            "Unsupported image data URL for protocol conversion: expected data:<mime>;base64,<data>",
            400,
        );
    }
    return { type: "url", url };
}

export default {
    appendAnthropicMessage,
    parseToolArguments,
    extractResponsesText,
    anthropicImageSourceToUrl,
    anthropicImageSourceFromUrl,
};
