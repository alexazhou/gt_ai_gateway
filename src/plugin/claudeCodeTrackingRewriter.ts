import { ApiFormat } from "../constants";
import customError from "../customError";
import { applyBodyPatch } from "./patch/applyPatch";
import type { JsonPatchOp, PluginHookHandler, RequestPlugin } from "./types";

/**
 * 「屏蔽 Claude Code 跟踪」请求插件（原 `removeClaudeCodeTrackingMarker` 的规则化形态）。
 *
 * 行为：把 `system` 里 `# currentDate` 块中的 `Today's date is yyyy/mm/dd.` 规范成 `yyyy-mm-dd`，
 * 避免同一天的不同写法破坏上游缓存命中。
 *
 * 只处理 anthropic 格式的请求体：同协议时在 `beforeConversion` 生效，
 * 跨协议（客户端 openai → 上游 anthropic）时在 `afterConversion` 生效，
 * 由 `context.currentFormat` 自判，两个钩子共用同一份实现。
 */

const TRACKING_REGEX = /(# currentDate\r?\n)Today(?:'|\u2019|\u02BC|\u02B9)s date is (\d{4})[/-](\d{2})[/-](\d{2})\.(\r?\n)/g;

const NORMALIZED_DATE = "$1Today's date is $2-$3-$4.$5";

/**
 * 计算补丁（纯函数）：返回需要 replace 的路径，不修改入参。
 * 无命中的 system 不产生任何操作 —— 管线层据此做到「未改写不留痕」。
 */
export function planTrackingMarkerRemoval(body: Readonly<Record<string, unknown>>): JsonPatchOp[] {
    const system = body.system;
    const ops: JsonPatchOp[] = [];

    if (typeof system === "string") {
        const next = system.replace(TRACKING_REGEX, NORMALIZED_DATE);
        if (next !== system) {
            ops.push({ op: "replace", path: "/system", value: next });
        }
        return ops;
    }

    if (Array.isArray(system)) {
        system.forEach((block, index) => {
            if (!block || typeof block !== "object") {
                return;
            }
            const { type, text } = block as { type?: unknown; text?: unknown };
            if (type !== "text" || typeof text !== "string") {
                return;
            }
            const next = text.replace(TRACKING_REGEX, NORMALIZED_DATE);
            if (next !== text) {
                ops.push({ op: "replace", path: `/system/${index}/text`, value: next });
            }
        });
    }

    return ops;
}


/**
 * 原始字符串接口（保留给既有单测与直调方）：解析 → 算补丁 → 应用 → 序列化。
 * 无命中时原样返回入参字符串（保持「没改动就不改字节」的既有契约）。
 */
export function removeClaudeCodeTrackingMarker(upstreamBody: string): string {
    try {
        const bodyJson = JSON.parse(upstreamBody);
        if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson)) {
            return upstreamBody;
        }
        const ops = planTrackingMarkerRemoval(bodyJson as Record<string, unknown>);
        if (ops.length === 0) {
            return upstreamBody;
        }
        return JSON.stringify(applyBodyPatch(bodyJson, ops).value);
    } catch (e) {
        console.log("[claudeCodeTrackingRewriter] Failed to process tracking marker:", e);
        return upstreamBody;
    }
}


/** 只处理 anthropic 请求体（before / after 两个阶段共用） */
const applyHook: PluginHookHandler = (request, context) => {
    if (context.currentFormat !== ApiFormat.ANTHROPIC) {
        return;
    }
    const bodyPatch = planTrackingMarkerRemoval(request.body);
    return bodyPatch.length > 0 ? { bodyPatch } : undefined;
};

export const claudeCodeTrackingRewriter: RequestPlugin = {
    name: "claudeCodeTrackingRewriter",
    description: "规范化 anthropic 系统提示词中的日期追踪标记，避免破坏上游缓存命中",
    configExample: {},
    beforeConversion: applyHook,
    afterConversion: applyHook,
    /** 无参数插件：任何参数都说明配置写错了 */
    validateConfig(pluginConfig: Record<string, unknown>): void {
        const keys = Object.keys(pluginConfig);
        if (keys.length > 0) {
            throw new customError.AppError(
                `claudeCodeTrackingRewriter takes no config, got: ${keys.join(", ")}`,
            );
        }
    },
};

export default claudeCodeTrackingRewriter;
