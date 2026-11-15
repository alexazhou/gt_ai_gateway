import { Context } from "hono";
import { getLogger } from "./loggerUtil";

/**
 * 后台任务异常必须"可见"：Worker 里 `task().catch(console.error)` 只会在 tail 里一闪而过，
 * 而这类任务承担的是结算/扣费收尾，静默失败等于丢账。这里同时写结构化日志（Node 落文件、
 * Worker 落 stderr）并保证异常不会变成未处理拒绝。
 */
function reportBackgroundError(e: unknown): void {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const logger = getLogger();
    if (logger) {
        try {
            logger.error(`[runInBackground] Background task failed: ${message}`, e);
        } catch (logError) {
            // 日志系统本身失败不能掩盖原始异常
            console.error("[runInBackground] Failed to write log:", logError);
        }
    }
    console.error("[runInBackground] Background task failed:", e);
}

/**
 * Safely execute background tasks after the response finishes.
 * Wraps Cloudflare Worker's executionCtx.waitUntil, and gracefully falls back in environments without it (e.g. Node.js).
 */
function runInBackground(c: Context, task: () => Promise<void>): void {
    let waitUntilFn: ((promise: Promise<unknown>) => void) | undefined;
    try {
        if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
            waitUntilFn = c.executionCtx.waitUntil.bind(c.executionCtx);
        }
    } catch (e) {
        // Ignore getter error in environments without ExecutionContext
    }

    // 统一挂 catch：无论走 waitUntil 还是本地兜底，都不产生未处理的 Promise 拒绝
    const guarded = () => task().catch(reportBackgroundError);

    if (waitUntilFn) {
        waitUntilFn(guarded());
    } else {
        void guarded();
    }
}

export default {
    runInBackground,
};
