import { ApiFormat } from "../constants";
import customError from "../customError";
import { applyBodyPatch } from "./patch/applyPatch";
import type { JsonPatchOp, PluginHookHandler, RequestPlugin } from "./types";

/**
 * 「强制改写 CCH」请求插件（原 `rewriteCchInSystemPrompt` 的规则化形态）。
 *
 * 行为：把 anthropic 系统提示词首段 `x-anthropic-billing-header: ... cch=xxx;` 里的
 * `cch` 值替换成规则参数 `cchValue`（默认 `A1234`），用于统一 billing 标识。
 *
 * 与老实现的差异只在「值可配」：老实现把 `A1234` 写死在正则替换里，现在由规则
 * `config.pluginConfig.cchValue` 提供，未提供时仍取 `A1234`（因此老行为不变）。
 */

/** 只匹配 system 开头（允许前导空白）的 billing header 首段 */
const CCH_REGEX = /^\s*(x-anthropic-billing-header:[\s\S]*?cch=)[^;]+(;)/;

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/** 默认 cch 值：与老实现写死的常量一致，保证零配置时行为等价 */
export const DEFAULT_CCH_VALUE = "A1234";

/** cchValue 只允许 1~32 位字母数字下划线短横线（避免注入、也避免正则替换里的 `$` 语义） */
const CCH_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const CCH_CONFIG_KEYS = ["cchValue"] as const;


/** 从规则参数里取 cchValue（未提供 / 空串 → 默认值） */
export function resolveCchValue(pluginConfig: Record<string, unknown> | undefined | null): string {
    const raw = pluginConfig?.cchValue;
    if (typeof raw === "string" && raw !== "") {
        return raw;
    }
    return DEFAULT_CCH_VALUE;
}


/**
 * 计算补丁（纯函数）：system 为字符串时改 `/system`，数组时只改首段 `/system/0/text`
 * （与老实现一致：只处理 billing header 所在的首段）。
 */
export function planCchRewrite(body: Readonly<Record<string, unknown>>, cchValue: string): JsonPatchOp[] {
    const system = body.system;

    if (typeof system === "string" && system.trim().startsWith(BILLING_HEADER_PREFIX)) {
        const next = system.replace(CCH_REGEX, `$1${cchValue}$2`);
        return next !== system ? [{ op: "replace", path: "/system", value: next }] : [];
    }

    if (Array.isArray(system) && system.length > 0) {
        const block = system[0] as { type?: unknown; text?: unknown } | null;
        if (
            block
            && block.type === "text"
            && typeof block.text === "string"
            && block.text.trim().startsWith(BILLING_HEADER_PREFIX)
        ) {
            const next = block.text.replace(CCH_REGEX, `$1${cchValue}$2`);
            return next !== block.text ? [{ op: "replace", path: "/system/0/text", value: next }] : [];
        }
    }

    return [];
}


/**
 * 原始字符串接口（保留给既有单测与直调方）：解析 → 算补丁 → 应用 → 序列化。
 * 无命中时原样返回入参字符串。
 */
export function rewriteCchInSystemPrompt(upstreamBody: string, cchValue: string = DEFAULT_CCH_VALUE): string {
    try {
        const bodyJson = JSON.parse(upstreamBody);
        if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson)) {
            return upstreamBody;
        }
        const ops = planCchRewrite(bodyJson as Record<string, unknown>, cchValue);
        if (ops.length === 0) {
            return upstreamBody;
        }
        return JSON.stringify(applyBodyPatch(bodyJson, ops).value);
    } catch (e) {
        console.log("[cchRewriter] Failed to rewrite cch:", e);
        return upstreamBody;
    }
}


/** 只处理 anthropic 请求体（before / after 两个阶段共用） */
const applyHook: PluginHookHandler = (request, context, pluginConfig) => {
    if (context.currentFormat !== ApiFormat.ANTHROPIC) {
        return;
    }
    const bodyPatch = planCchRewrite(request.body, resolveCchValue(pluginConfig));
    return bodyPatch.length > 0 ? { bodyPatch } : undefined;
};

export const cchRewriter: RequestPlugin = {
    name: "cchRewriter",
    description: "把 anthropic 系统提示词首段 billing header 中的 cch 值改写为指定值",
    configExample: { cchValue: DEFAULT_CCH_VALUE },
    beforeConversion: applyHook,
    afterConversion: applyHook,
    /** 只允许 cchValue，且必须是 1~32 位 [A-Za-z0-9_-] */
    validateConfig(pluginConfig: Record<string, unknown>): void {
        const unknownKeys = Object.keys(pluginConfig).filter(
            (key) => !(CCH_CONFIG_KEYS as readonly string[]).includes(key),
        );
        if (unknownKeys.length > 0) {
            throw new customError.AppError(`Unknown cchRewriter config field(s): ${unknownKeys.join(", ")}`);
        }
        const value = pluginConfig.cchValue;
        if (value === undefined) {
            return;
        }
        if (typeof value !== "string" || !CCH_VALUE_PATTERN.test(value)) {
            throw new customError.AppError(
                "config.pluginConfig.cchValue must be 1~32 characters of letters, digits, underscore or hyphen",
            );
        }
    },
};

export default cchRewriter;
