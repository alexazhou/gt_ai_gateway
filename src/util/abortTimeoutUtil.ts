import { FailedCode } from "../constants";


/**
 * 覆盖「有限界等待」的一个类：既有固定时限（构造时中止信号，供 fetch / 读 body），
 * 也有空闲时限（raceWithTimeout，供流式读循环里对每次 await 单独计时），
 * 并把「客户端断开」合并进同一个信号，直接给出中止对应的失败码。
 *
 * 用法：
 *   const abort = new TimeoutAbortController(timeoutMs, c.req.raw.signal);
 *   try {
 *       await fetch(url, { signal: abort.signal, ... });          // 固定时限：超时/断开都会中止
 *       const text = await abort.readText(res);                   // 读 body 同样受控（内部取消 body）
 *       await abort.raceWithTimeout(reader.read(), idleMs, cb);   // 空闲时限：每次 await 单独计时
 *   } catch (e) {
 *       const code = abort.failedCode() ?? FailedCode.UPSTREAM_DISCONNECTED;
 *   } finally {
 *       abort.dispose();   // clearTimeout + 移除客户端断开监听
 *   }
 *
 * 约定：
 * - timeoutMs <= 0 表示关闭固定超时（仅客户端断开可中止）。
 * - 客户端信号已中断（fetch 前就已断开）时，结果信号立即处于中止态，onAbort 会立即触发。
 * - onAbort 可注册多个回调；dispose() 幂等，可安全调用多次。
 */
export class TimeoutAbortController {
    /** 传给 fetch / 读取的中止信号 */
    readonly signal: AbortSignal;

    private readonly controller = new AbortController();
    private readonly clientAbortSignal: AbortSignal | undefined;
    private timedOut = false;
    private readonly timer: ReturnType<typeof setTimeout> | undefined;
    private readonly unsubscribeClient: () => void;

    constructor(timeoutMs: number, clientAbortSignal: AbortSignal | undefined) {
        this.signal = this.controller.signal;
        this.clientAbortSignal = clientAbortSignal;
        if (timeoutMs > 0) {
            this.timer = setTimeout(() => {
                this.timedOut = true;
                this.controller.abort();
            }, timeoutMs);
        }
        this.unsubscribeClient = this.subscribeAbort(clientAbortSignal, () => this.controller.abort());
    }

    /** 中止原因对应的失败码：客户端断开 / 超时；未中止返回 null（如普通网络错误） */
    failedCode(): FailedCode | null {
        if (this.clientAbortSignal?.aborted) {
            return FailedCode.CLIENT_DISCONNECTED;
        }
        if (this.timedOut) {
            return FailedCode.UPSTREAM_TIMEOUT;
        }
        return null;
    }

    /**
     * 注册一个在信号中止时触发的回调（信号已中止则立即触发，保证不遗漏「注册前已断开」）。
     * 返回取消订阅函数。
     */
    onAbort(handler: () => void): () => void {
        return this.subscribeAbort(this.controller.signal, handler);
    }

    /**
     * 以文本形式读取响应体，受本控制器中止控制：中止（超时 / 客户端断开）时取消 body 并 reject。
     * Response.text() 不接收 signal，故由这里统一处理「中止 → body.cancel()」。
     */
    async readText(res: Response): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const unsubscribeAbort = this.onAbort(() => {
                res.body?.cancel().catch(() => {});
                reject(new Error("upstream response body aborted"));
            });
            res.text().then(
                (text) => { unsubscribeAbort(); resolve(text); },
                (err) => { unsubscribeAbort(); reject(err); },
            );
        });
    }

    /**
     * 对单个异步等待施加「空闲超时」：任务在 timeoutMs 内未完成则触发 onTimeout 并 reject，
     * 任务先完成则正常返回。每次调用都会新建计时（idle 语义，适合流式读循环里对每次 read() 的等待）。
     * timeoutMs <= 0 表示不设限。
     */
    raceWithTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
        if (timeoutMs <= 0) {
            return task;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutReject = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                onTimeout();
                reject(new Error("wait timed out"));
            }, timeoutMs);
        });
        return Promise.race([task, timeoutReject]).finally(() => clearTimeout(timer));
    }

    /**
     * 订阅中止信号，统一处理「信号已中断」与「信号随后中断」两种时机：
     * - 信号已中断（addEventListener 对已中断信号不会再触发）：立即同步执行 handler；
     * - 否则挂监听，中断时执行 handler。
     * 返回取消订阅函数（信号已中断时返回空操作，避免重复执行）。
     * 由于「检查 aborted」与「挂监听」之间无异步间隙，不会重复触发。
     */
    private subscribeAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
        if (!signal) {
            return () => {};
        }
        if (signal.aborted) {
            handler();
            return () => {};
        }
        signal.addEventListener("abort", handler);
        return () => signal.removeEventListener("abort", handler);
    }

    /** 清理定时器与客户端断开监听（在 finally 中调用） */
    dispose(): void {
        clearTimeout(this.timer);
        this.unsubscribeClient();
    }
}