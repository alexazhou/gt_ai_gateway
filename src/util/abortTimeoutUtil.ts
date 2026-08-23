import { FailedCode } from "../constants";


/**
 * 订阅中止信号：统一处理「信号已中断」与「信号随后中断」两种时机。
 * - 信号已中断（addEventListener 对已中断信号不会再触发）：立即同步执行 handler；
 * - 否则挂监听，中断时执行 handler。
 * 返回取消订阅函数（信号已中断时返回空操作，避免重复执行）。
 * 由于「检查 aborted」与「挂监听」之间无异步间隙，不会重复触发。
 */
function onSignalAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
    if (!signal) return () => {};
    if (signal.aborted) { handler(); return () => {}; }
    signal.addEventListener("abort", handler);
    return () => signal.removeEventListener("abort", handler);
}


/**
 * 对单个异步等待施加「空闲超时」：任务在 timeoutMs 内未完成则触发 onTimeout 并 reject，
 * 任务先完成则正常返回。每次调用都会新建计时（idle 语义，适合流式读循环里对每次 read() 的等待）。
 * timeoutMs <= 0 表示不设限。
 */
function raceWithTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
    if (timeoutMs <= 0) return task;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutReject = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(new Error("wait timed out")); }, timeoutMs);
    });
    return Promise.race([task, timeoutReject]).finally(() => clearTimeout(timer));
}


/**
 * 以文本形式读取响应体，受中止信号控制：中止时取消 body 并 reject。
 * Response.text() 不接收 signal，由这里统一处理「中止 → body.cancel()」。
 * 内部原语，供 readTextWithTimeoutAndAbort 使用。
 */
async function readTextWithSignal(res: Response, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const onAbort = () => {
            res.body?.cancel().catch(() => {});
            reject(new Error("upstream response body aborted"));
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort);
        res.text().then(
            (text) => { signal.removeEventListener("abort", onAbort); resolve(text); },
            (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
        );
    });
}


/** 读取响应体失败时抛出的错误：携带失败原因对应的失败码，供调用方记账与处理 */
class BodyReadError extends Error {
    constructor(public readonly failedCode: FailedCode) {
        super(`upstream response body read failed: ${failedCode}`);
    }
}


/**
 * 一次封装「非流式 body 读取」的三类失败兜底：
 * - 上游断开（连接中断 / 读取失败） → UPSTREAM_DISCONNECTED
 * - 超时（timeoutMs 内未读完）     → UPSTREAM_TIMEOUT
 * - 下游断开（客户端 abort）       → CLIENT_DISCONNECTED
 *
 * 内部用 TimeoutAbortController 合并「超时 + 客户端信号」，读取失败统一抛 BodyReadError
 * （e.failedCode 即原因），正常读完返回文本。timeoutMs <= 0 关闭超时；clientAbortSignal 可省略。
 */
async function readTextWithTimeoutAndAbort(
    res: Response,
    timeoutMs: number,
    clientAbortSignal?: AbortSignal,
): Promise<string> {
    const abortCtrl = new TimeoutAbortController(timeoutMs, clientAbortSignal);
    try {
        return await readTextWithSignal(res, abortCtrl.signal);
    } catch (e) {
        throw new BodyReadError(abortCtrl.failedCode() ?? FailedCode.UPSTREAM_DISCONNECTED);
    } finally {
        abortCtrl.dispose();
    }
}


/**
 * 合并「超时」与「客户端断连」为统一 AbortSignal，并追踪中止原因，直接给出失败码。
 *
 * 用法（fetch 走 signal；读 body 走 readTextWithTimeoutAndAbort 一次性兜底）：
 *   const abort = new TimeoutAbortController(timeoutMs, c.req.raw.signal);
 *   try {
 *       await fetch(url, { signal: abort.signal });
 *       const text = await readTextWithTimeoutAndAbort(res, timeoutMs, c.req.raw.signal);
 *   } catch (e) {
 *       const code = e instanceof BodyReadError ? e.failedCode : abort.failedCode();
 *   } finally {
 *       abort.dispose();
 *   }
 *
 * 约定：
 * - timeoutMs <= 0 表示关闭固定超时（仅客户端断开可中止）。
 * - 客户端信号已中断（fetch 前就已断开）时，结果信号立即处于中止态。
 * - dispose() 幂等，可安全调用多次。
 */
class TimeoutAbortController {
    /** 传给 fetch / 读取的中止信号 */
    readonly signal: AbortSignal;

    private readonly controller = new AbortController();
    private readonly clientAbortSignal: AbortSignal | undefined;
    private timedOut = false;
    private readonly timer: ReturnType<typeof setTimeout> | undefined;
    private readonly unsubscribeClient: () => void;

    constructor(timeoutMs: number, clientAbortSignal?: AbortSignal) {
        this.signal = this.controller.signal;
        this.clientAbortSignal = clientAbortSignal;
        if (timeoutMs > 0) {
            this.timer = setTimeout(() => { this.timedOut = true; this.controller.abort(); }, timeoutMs);
        }
        this.unsubscribeClient = onSignalAbort(clientAbortSignal, () => this.controller.abort());
    }

    /** 中止原因对应的失败码：客户端断开 / 超时；未中止返回 null（如普通网络错误） */
    failedCode(): FailedCode | null {
        if (this.clientAbortSignal?.aborted) return FailedCode.CLIENT_DISCONNECTED;
        if (this.timedOut) return FailedCode.UPSTREAM_TIMEOUT;
        return null;
    }

    /** 清理定时器与客户端断开监听（在 finally 中调用） */
    dispose(): void {
        clearTimeout(this.timer);
        this.unsubscribeClient();
    }
}


export default {
    TimeoutAbortController,
    BodyReadError,
    onSignalAbort,
    raceWithTimeout,
    readTextWithTimeoutAndAbort,
};