import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import customError from "../../customError";
import objectUtil from "../objectUtil";
import type {
    AnthropicContentBlock,
    AnthropicRequest,
    AnthropicStreamUsage,
    AnthropicUsage,
} from "../protocol/anthropicTypes";
import type { OpenAIStreamUsage, OpenAIUsage } from "../protocol/openaiTypes";
import type {
    ResponsesContentPart,
    ResponsesStreamUsage,
    ResponsesUsage,
} from "../protocol/responsesTypes";


export interface RawOpenAIUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
}

export interface RawAnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

export interface RawResponsesUsage {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
}


/**
 * 合并 OpenAI Chat 原始 usage（逐字段保留旧值，显式 0 覆盖旧值）
 */
function mergeOpenAIUsage(target: RawOpenAIUsage, source?: OpenAIStreamUsage | null): RawOpenAIUsage {
    if (!source) return target;
    if (source.prompt_tokens != null) target.prompt_tokens = source.prompt_tokens;
    if (source.completion_tokens != null) target.completion_tokens = source.completion_tokens;
    if (source.total_tokens != null) target.total_tokens = source.total_tokens;
    if (source.prompt_tokens_details?.cached_tokens != null) {
        target.cached_tokens = source.prompt_tokens_details.cached_tokens;
    }
    if (source.prompt_tokens_details?.cache_write_tokens != null) {
        target.cache_write_tokens = source.prompt_tokens_details.cache_write_tokens;
    }
    if (source.completion_tokens_details?.reasoning_tokens != null) {
        target.reasoning_tokens = source.completion_tokens_details.reasoning_tokens;
    }
    return target;
}


/**
 * 合并 Anthropic 原始 usage（逐字段保留旧值，显式 0 覆盖旧值）
 */
function mergeAnthropicUsage(target: RawAnthropicUsage, source?: AnthropicStreamUsage | null): RawAnthropicUsage {
    if (!source) return target;
    if (source.input_tokens != null) target.input_tokens = source.input_tokens;
    if (source.output_tokens != null) target.output_tokens = source.output_tokens;
    if (source.cache_read_input_tokens != null) {
        target.cache_read_input_tokens = source.cache_read_input_tokens;
    }
    if (source.cache_creation_input_tokens != null) {
        target.cache_creation_input_tokens = source.cache_creation_input_tokens;
    }
    return target;
}


/**
 * 合并 Responses 原始 usage（逐字段保留旧值，显式 0 覆盖旧值）
 */
function mergeResponsesUsage(target: RawResponsesUsage, source?: ResponsesStreamUsage | null): RawResponsesUsage {
    if (!source) return target;
    if (source.input_tokens != null) target.input_tokens = source.input_tokens;
    if (source.output_tokens != null) target.output_tokens = source.output_tokens;
    if (source.total_tokens != null) target.total_tokens = source.total_tokens;
    if (source.input_tokens_details?.cached_tokens != null) {
        target.cached_tokens = source.input_tokens_details.cached_tokens;
    }
    if (source.output_tokens_details?.reasoning_tokens != null) {
        target.reasoning_tokens = source.output_tokens_details.reasoning_tokens;
    }
    return target;
}


/**
 * OpenAI Chat usage → Anthropic usage（非缓存输入 = max(0, prompt_tokens - cached_tokens)）
 */
function openAIUsageToAnthropic(raw: RawOpenAIUsage): AnthropicUsage {
    const promptTotal = raw.prompt_tokens ?? 0;
    const cached = raw.cached_tokens;
    const inputTokens = cached !== undefined ? Math.max(0, promptTotal - cached) : promptTotal;
    const outputTokens = raw.completion_tokens ?? 0;
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
        ...(raw.cache_write_tokens !== undefined ? { cache_creation_input_tokens: raw.cache_write_tokens } : {}),
    };
}


/**
 * OpenAI Chat usage → Responses usage（prompt_tokens 已含缓存，不再重复相加）
 */
function openAIUsageToResponses(raw: RawOpenAIUsage): ResponsesUsage {
    const inputTokens = raw.prompt_tokens ?? 0;
    const outputTokens = raw.completion_tokens ?? 0;
    const usage: ResponsesUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
    };
    if (raw.cached_tokens !== undefined) {
        usage.input_tokens_details = { cached_tokens: raw.cached_tokens };
    }
    if (raw.reasoning_tokens !== undefined) {
        usage.output_tokens_details = { reasoning_tokens: raw.reasoning_tokens };
    }
    return usage;
}


/**
 * Anthropic usage → OpenAI Chat usage（prompt_tokens = 非缓存输入 + 缓存命中）
 */
function anthropicUsageToOpenAI(raw: RawAnthropicUsage): OpenAIUsage {
    const cached = raw.cache_read_input_tokens;
    const cacheWrite = raw.cache_creation_input_tokens;
    const promptTokens = (raw.input_tokens ?? 0) + (cached ?? 0);
    const completionTokens = raw.output_tokens ?? 0;
    const usage: OpenAIUsage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
    };
    if (cached !== undefined || cacheWrite !== undefined) {
        usage.prompt_tokens_details = {
            ...(cached !== undefined ? { cached_tokens: cached } : {}),
            ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
        };
    }
    return usage;
}


/**
 * Anthropic usage → Responses usage（input_tokens = 非缓存输入 + 缓存命中）
 */
function anthropicUsageToResponses(raw: RawAnthropicUsage): ResponsesUsage {
    const cached = raw.cache_read_input_tokens;
    const inputTokens = (raw.input_tokens ?? 0) + (cached ?? 0);
    const outputTokens = raw.output_tokens ?? 0;
    const usage: ResponsesUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
    };
    if (cached !== undefined) {
        usage.input_tokens_details = { cached_tokens: cached };
    }
    return usage;
}


/**
 * Responses usage → OpenAI Chat usage
 */
function responsesUsageToOpenAI(raw: RawResponsesUsage): OpenAIUsage {
    const inputTokens = raw.input_tokens ?? 0;
    const outputTokens = raw.output_tokens ?? 0;
    const usage: OpenAIUsage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: raw.total_tokens ?? (inputTokens + outputTokens),
    };
    if (raw.cached_tokens !== undefined) {
        usage.prompt_tokens_details = { cached_tokens: raw.cached_tokens };
    }
    if (raw.reasoning_tokens !== undefined) {
        usage.completion_tokens_details = { reasoning_tokens: raw.reasoning_tokens };
    }
    return usage;
}


/**
 * Responses usage → Anthropic usage（非缓存输入 = max(0, input_tokens - cached_tokens)）
 */
function responsesUsageToAnthropic(raw: RawResponsesUsage): AnthropicUsage {
    const inputTotal = raw.input_tokens ?? 0;
    const cached = raw.cached_tokens;
    const inputTokens = cached !== undefined ? Math.max(0, inputTotal - cached) : inputTotal;
    const outputTokens = raw.output_tokens ?? 0;
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    };
}

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

const THINKING_SIG_PREFIX = "gw_sig_v1";
const RUNTIME_THINKING_SIG_SECRET = randomBytes(32).toString("hex");

function getThinkingSignatureSecret(): string {
    return process.env.THINKING_SIGNATURE_SECRET
        || process.env.JWT_SECRET
        || RUNTIME_THINKING_SIG_SECRET;
}


interface SealedThinkingPayload {
    v: 1;
    src: "anthropic" | "responses";
    model?: string;
    thinking?: string;
    signature: string;
}


/**
 * 将上游 thinking 签名 / encrypted_content 包装为带 HMAC 完整性校验的恢复凭据。
 * 绑定原始协议与模型信息，防止跨供应商或篡改后的密文被误转交。
 */
function sealThinkingSignature(
    src: "anthropic" | "responses",
    signature: string,
    options?: { model?: string; thinking?: string },
): string {
    if (!signature) return "";
    const payload: SealedThinkingPayload = {
        v: 1,
        src,
        signature,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.thinking !== undefined ? { thinking: options.thinking } : {}),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const macB64 = createHmac("sha256", getThinkingSignatureSecret())
        .update(payloadB64)
        .digest("base64url");
    return `${THINKING_SIG_PREFIX}.${payloadB64}.${macB64}`;
}


/**
 * 校验并解包网关签发的 thinking 恢复凭据；来源不匹配、模型不匹配或验签失败时返回 null。
 */
function unsealThinkingSignature(
    token: string,
    expectedSrc: "anthropic" | "responses",
    expectedModel?: string,
): { signature: string; thinking?: string } | null {
    if (!token || !token.startsWith(`${THINKING_SIG_PREFIX}.`)) {
        return null;
    }
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1] || !parts[2]) {
        return null;
    }
    const [, payloadB64, macB64] = parts;
    const expectedMac = createHmac("sha256", getThinkingSignatureSecret())
        .update(payloadB64)
        .digest();
    let actualMac: Buffer;
    try {
        actualMac = Buffer.from(macB64, "base64url");
    } catch {
        return null;
    }
    if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
        return null;
    }

    let payload: unknown;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (!objectUtil.isRecord(payload)) return null;
    if (payload.v !== 1 || payload.src !== expectedSrc) return null;
    if (typeof payload.signature !== "string" || !payload.signature) return null;
    if (expectedModel && typeof payload.model === "string" && payload.model !== expectedModel) {
        return null;
    }
    return {
        signature: payload.signature,
        thinking: typeof payload.thinking === "string" ? payload.thinking : undefined,
    };
}


export default {
    appendAnthropicMessage,
    parseToolArguments,
    extractResponsesText,
    anthropicImageSourceToUrl,
    anthropicImageSourceFromUrl,
    mergeOpenAIUsage,
    mergeAnthropicUsage,
    mergeResponsesUsage,
    openAIUsageToAnthropic,
    openAIUsageToResponses,
    anthropicUsageToOpenAI,
    anthropicUsageToResponses,
    responsesUsageToOpenAI,
    responsesUsageToAnthropic,
    sealThinkingSignature,
    unsealThinkingSignature,
};
