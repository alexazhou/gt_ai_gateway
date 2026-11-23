import { createHmac, timingSafeEqual } from "node:crypto";
import customError from "../../customError";
import objectUtil from "../objectUtil";
import type {
    AnthropicCacheControl,
    AnthropicContentBlock,
    AnthropicRequest,
    AnthropicStreamUsage,
    AnthropicTool,
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


// ─── Anthropic 请求缓存断点补全（#295，方案见 doc/tech/anthropic_cache_control_design.md）───
// 口径（2026-11-23 Operator 定，方案 B）：**本段只加字段，绝不改请求形状**。
// 字符串形态的 system / content 一律跳过（形状由转换层统一产出块数组），见 markLastSystemBlock / markLastUserMessageBlock。

/**
 * 显式缓存断点总数上限。文档 §4.4 第一版按 4 个设计；
 * 目标上游与兼容供应商的真实限制需要在有凭据的环境确认（§8.2 第 1 条）。
 */
const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;

/** 自动补全写入的标记；**不设 ttl**，用目标协议默认短期缓存。 */
const ANTHROPIC_EPHEMERAL_CACHE: AnthropicCacheControl = { type: "ephemeral" };

/**
 * 可自动标记的内容块类型。`thinking` 明确**不在**其中（§4.3）：
 * 不直接给 thinking 块加标记，也不改其明文或 signature。
 */
const ANTHROPIC_CACHEABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(["text", "image", "tool_result"]);

function isLegalAnthropicCacheControl(value: unknown): value is AnthropicCacheControl {
    return objectUtil.isRecord(value) && (value as { type?: unknown }).type === "ephemeral";
}

/**
 * 已有断点的扫描结果：
 * - `count` 合法标记数
 * - `illegal` 非法标记的位置
 * - `positions` 合法标记的位置（给「超过上限」的错误文案点名用）
 */
interface AnthropicCacheScan {
    count: number;
    illegal: string[];
    positions: string[];
}

function scanAnthropicCacheBreakpoints(req: AnthropicRequest): AnthropicCacheScan {
    const illegal: string[] = [];
    const positions: string[] = [];
    let count = 0;

    const visit = (holder: { cache_control?: unknown }, where: string): void => {
        if (holder.cache_control === undefined) {
            return;
        }
        if (isLegalAnthropicCacheControl(holder.cache_control)) {
            count += 1;
            positions.push(where);
        } else {
            illegal.push(where);
        }
    };

    (req.tools ?? []).forEach((tool, index) => visit(tool, `tools[${index}]`));

    if (Array.isArray(req.system)) {
        req.system.forEach((block, index) => visit(block, `system[${index}]`));
    }

    req.messages.forEach((message, messageIndex) => {
        if (!Array.isArray(message.content)) {
            return;
        }
        message.content.forEach((block, blockIndex) => {
            // 只检查**内容块本身**：tool_result 的嵌套 content、工具 input_schema、
            // 工具入参里的同名键都是业务数据，不是协议断点（§4.4 末段）。
            visit(block, `messages[${messageIndex}].content[${blockIndex}]`);
        });
    });

    return { count, illegal, positions };
}

/** 消息断点：最后一条 user 消息里最后一个可标记块；无可标记块时跳过（不越界去标 assistant）。 */
function markLastUserMessageBlock(req: AnthropicRequest): boolean {
    for (let index = req.messages.length - 1; index >= 0; index -= 1) {
        const message = req.messages[index];
        if (message.role !== "user") {
            continue;
        }
        if (typeof message.content === "string") {
            // 只加字段、不改形状（方案 B）：字符串形态由转换层负责产出块数组，
            // 这里遇到字符串一律跳过，绝不把 content 改写成数组。
            return false;
        }
        for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
            const block = message.content[blockIndex];
            if (!ANTHROPIC_CACHEABLE_BLOCK_TYPES.has(block.type)) {
                continue;
            }
            if (block.cache_control !== undefined) {
                // 该位置已有标记：保留原位置，不重复添加（幂等的关键一环）
                return false;
            }
            if (block.type === "text" && !block.text) {
                continue;
            }
            block.cache_control = { ...ANTHROPIC_EPHEMERAL_CACHE };
            return true;
        }
        return false;
    }
    return false;
}

/** 系统断点：最后一个可标记的 system 文本块；字符串先规范化为单文本块数组。 */
function markLastSystemBlock(req: AnthropicRequest): boolean {
    if (req.system === undefined) {
        return false;
    }
    if (typeof req.system === "string") {
        // 只加字段、不改形状（方案 B）：字符串形态一律跳过，不改写成块数组。
        return false;
    }
    for (let index = req.system.length - 1; index >= 0; index -= 1) {
        const block = req.system[index];
        if (block.type !== "text" || !block.text) {
            continue;
        }
        if (block.cache_control !== undefined) {
            return false;
        }
        block.cache_control = { ...ANTHROPIC_EPHEMERAL_CACHE };
        return true;
    }
    return false;
}

/** 工具断点：最后一个工具定义。 */
function markLastTool(req: AnthropicRequest): boolean {
    const tools: AnthropicTool[] | undefined = req.tools;
    if (!tools || tools.length === 0) {
        return false;
    }
    const tool = tools[tools.length - 1];
    if (tool.cache_control !== undefined) {
        return false;
    }
    tool.cache_control = { ...ANTHROPIC_EPHEMERAL_CACHE };
    return true;
}

/**
 * 为「转 Anthropic」的请求补全显式缓存断点（Chat→Anthropic 与 Responses→Anthropic 共用）。
 *
 * 规则（文档 §4，实现前已定稿，此处只落一份）：
 * - 三处候选：`tools` 最后一个工具 / `system` 最后一个可标记文本块 /
 *   `messages` 最后一条 user 消息的最后一个可标记块（含 `tool_result` 外层块）。
 * - 优先级：消息 → system → tools（§4.4 第 3 条，有限预算时先补最能随对话推进而复用的前缀）。
 * - 已有合法标记保留原位置与设置；候选位置已有标记则不重复添加 ⇒ 同一请求重复调用结果相同（幂等）。
 * - 非法标记或已有标记超过上限 ⇒ **明确拒绝**（400），不静默删除客户端配置。
 * - 空 system / 空内容 / 空工具不生成占位块；`thinking` 不加标记。
 * - **只加字段、不改形状**：遇到字符串形态的 system / message content 直接跳过，
 *   绝不把字符串改写成块数组（形状由转换器统一产出）。
 *
 * 原地修改并返回同一个请求对象：调用点都是「构造完成后、返回前」，无需额外拷贝。
 */
function applyAnthropicCacheControl(req: AnthropicRequest): AnthropicRequest {
    const scan = scanAnthropicCacheBreakpoints(req);
    // 两种拒绝的文案都必须自带三件事：**位置**（哪个字段带的问题）、**原因**（非法取值 / 超上限，
    // 两者要能一眼区分）、**上限值**。只说「invalid cache_control」等于让客户端换个地方猜。
    if (scan.illegal.length > 0) {
        throw new customError.AppError(
            `Invalid cache_control at ${scan.illegal.join(", ")}: unsupported value, `
            + `only {"type":"ephemeral"} is accepted; this gateway allows at most `
            + `${MAX_ANTHROPIC_CACHE_BREAKPOINTS} cache breakpoints per request`,
            400,
        );
    }
    if (scan.count > MAX_ANTHROPIC_CACHE_BREAKPOINTS) {
        throw new customError.AppError(
            `Anthropic request carries ${scan.count} cache breakpoints `
            + `(${scan.positions.join(", ")}), exceeding the limit of `
            + `${MAX_ANTHROPIC_CACHE_BREAKPOINTS}; refusing to drop client markers`,
            400,
        );
    }

    let remaining = MAX_ANTHROPIC_CACHE_BREAKPOINTS - scan.count;
    if (remaining > 0 && markLastUserMessageBlock(req)) {
        remaining -= 1;
    }
    if (remaining > 0 && markLastSystemBlock(req)) {
        remaining -= 1;
    }
    if (remaining > 0 && markLastTool(req)) {
        remaining -= 1;
    }
    return req;
}


/**
 * 解析工具调用的 JSON 参数；非法 JSON 或非对象结果时返回空对象。
 */
function parseToolArguments(args: string): Record<string, unknown> {    try {
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

/**
 * 封装 thinking 凭据用的固定密钥。
 *
 * 为什么是固定值而不是随机生成：
 * 1. 随机密钥是 per-isolate 的 —— 第一轮由 isolate A 签发、第二轮打到 isolate B（或 isolate 重启）就验签失败，
 *    跨协议 + thinking 的多轮对话会直接 400。要做成随机就必须引入稳定存储（config 表 / wrangler secret），
 *    而 config 表要异步读，转换层是同步的（convertRequest / convertResponse / convertStreamEvent 全是同步签名），
 *    为此把整条转换链路改成 async 不值得。
 * 2. 这层 HMAC 的实际职责是「网关自己重打包时绑定来源协议 / 模型，并发现无意间的篡改」，
 *    而不是对外提供认证能力：源码里的常量等于公开，能改源码的人本来就能改任何行为。
 *    真正兜底的是上游自己 —— Anthropic 会校验 signature 与 thinking 明文是否匹配，
 *    客户端伪造的凭据送到上游只会 400，不会污染上下文。
 *
 * 需要更强保证时，用 `THINKING_SIGNATURE_SECRET`（wrangler secret / .dev.vars）覆盖，无需改代码。
 */
const DEFAULT_THINKING_SIG_SECRET = "9f1c815f2860a5897f7ed916822eeb062b2e3211fc1c5f635c6d4b056902293a";

function getThinkingSignatureSecret(): string {
    return process.env.THINKING_SIGNATURE_SECRET || DEFAULT_THINKING_SIG_SECRET;
}


interface SealedThinkingPayload {
    v: 1;
    src: "anthropic" | "responses";
    model?: string;
    /** 上游来源标识（`vendor:<id>`）：凭据只对签出它的上游来源有效（PC-009-C） */
    source?: string;
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
    options?: { model?: string; thinking?: string; source?: string },
): string {
    if (!signature) return "";
    const payload: SealedThinkingPayload = {
        v: 1,
        src,
        signature,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.source ? { source: options.source } : {}),
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
    /**
     * 期望的上游来源（`vendor:<id>`）。仅在**凭据自身带 source** 时校验：
     * 老凭据没有该字段，保持向后兼容（否则升级瞬间在途多轮对话全部 400）。
     */
    expectedSource?: string,
): {
    signature: string;
    thinking?: string;
    /**
     * 本次是否**真的**核对过来源：
     * - `true`：凭据自带 `source` 且与期望值相等（新凭据，来源已强制校验）；
     * - `false`：老凭据没有 `source` 字段 ⇒ 只校验了模型，来源**未校验**（调用方必须留痕）。
     */
    sourceChecked: boolean;
} | null {
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
    if (expectedSource && typeof payload.source === "string" && payload.source !== expectedSource) {
        return null;
    }
    return {
        signature: payload.signature,
        thinking: typeof payload.thinking === "string" ? payload.thinking : undefined,
        sourceChecked: Boolean(expectedSource && typeof payload.source === "string"),
    };
}


export default {
    appendAnthropicMessage,
    parseToolArguments,
    extractResponsesText,
    anthropicImageSourceToUrl,
    anthropicImageSourceFromUrl,
    applyAnthropicCacheControl,
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
