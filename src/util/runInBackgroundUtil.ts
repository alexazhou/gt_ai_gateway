import { Context } from "hono";

/**
 * Safely execute background tasks after the response finishes.
 * Wraps Cloudflare Worker's executionCtx.waitUntil, and gracefully falls back in environments without it (e.g. Node.js).
 */
export function runInBackground(c: Context, task: () => Promise<void>) {
    let waitUntilFn: ((promise: Promise<unknown>) => void) | undefined;
    try {
        if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
            waitUntilFn = c.executionCtx.waitUntil.bind(c.executionCtx);
        }
    } catch (e) {
        // Ignore getter error in environments without ExecutionContext
    }

    if (waitUntilFn) {
        waitUntilFn(task());
    } else {
        task().catch(e => console.error("[runInBackground] Error in background task:", e));
    }
}
