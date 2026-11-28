import { ApiFormat } from "../constants";
import customError from "../customError";
import { applyBodyPatch } from "./patch/applyPatch";
import type { JsonPatchOp, PluginHookHandler, RequestPlugin } from "./types";

/**
 * 「Responses API 粘性路由」请求插件（原 `injectResponsesPromptCacheKey` 的规则化形态）。
 *
 * 行为：请求未携带 `prompt_cache_key` 时注入 `${hostKey}:${clientName}`，
 * 让同一客户端在同一网关实例上的请求落到同一上游缓存，提升缓存命中率。
 */

function normalizePromptCacheKeyPart(value: string | null | undefined, fallback: string): string {
    const trimmed = (value ?? "").trim();
    return trimmed || fallback;
}


export function buildResponsesPromptCacheKey(hostKey: string, clientName: string | null | undefined): string {
    const safeHostKey = normalizePromptCacheKeyPart(hostKey, "local");
    const safeClientName = normalizePromptCacheKeyPart(clientName, "unknown");
    return `${safeHostKey}:${safeClientName}`;
}


/**
 * 计算补丁（纯函数）：已携带 `prompt_cache_key` 时不动（客户端/前序规则优先），
 * 否则 `add /prompt_cache_key`（add 对不存在的键等价于新增，键序与老实现一致：追加在末尾）。
 */
export function planPromptCacheKeyInjection(
    body: Readonly<Record<string, unknown>>,
    hostKey: string,
    clientName: string | null | undefined,
): JsonPatchOp[] {
    const existing = body.prompt_cache_key;
    if (existing !== undefined && existing !== null && existing !== "") {
        return [];
    }
    return [{ op: "add", path: "/prompt_cache_key", value: buildResponsesPromptCacheKey(hostKey, clientName) }];
}


/**
 * 原始字符串接口（保留给既有单测与直调方）：解析 → 算补丁 → 应用 → 序列化。
 * 无需注入时原样返回入参字符串。
 */
export function injectResponsesPromptCacheKey(
    upstreamBody: string,
    hostKey: string,
    clientName: string | null | undefined,
): string {
    try {
        const bodyJson = JSON.parse(upstreamBody);
        if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson)) {
            return upstreamBody;
        }
        const ops = planPromptCacheKeyInjection(bodyJson as Record<string, unknown>, hostKey, clientName);
        if (ops.length === 0) {
            return upstreamBody;
        }
        return JSON.stringify(applyBodyPatch(bodyJson, ops).value);
    } catch (e) {
        console.log("[responsesPromptCacheKeyRewriter] Failed to inject prompt_cache_key:", e);
        return upstreamBody;
    }
}


/** 只处理 responses 请求体（before / after 两个阶段共用） */
const applyHook: PluginHookHandler = (request, context) => {
    if (context.currentFormat !== ApiFormat.RESPONSES) {
        return;
    }
    const bodyPatch = planPromptCacheKeyInjection(request.body, context.hostKey, context.clientName);
    return bodyPatch.length > 0 ? { bodyPatch } : undefined;
};

export const responsesPromptCacheKeyRewriter: RequestPlugin = {
    name: "responsesPromptCacheKeyRewriter",
    description: "Responses API 请求未携带 prompt_cache_key 时注入网关实例标识，提升上游缓存命中率",
    configExample: {},
    beforeConversion: applyHook,
    afterConversion: applyHook,
    /** 无参数插件：任何参数都说明配置写错了 */
    validateConfig(pluginConfig: Record<string, unknown>): void {
        const keys = Object.keys(pluginConfig);
        if (keys.length > 0) {
            throw new customError.AppError(
                `responsesPromptCacheKeyRewriter takes no config, got: ${keys.join(", ")}`,
            );
        }
    },
};

export default responsesPromptCacheKeyRewriter;
