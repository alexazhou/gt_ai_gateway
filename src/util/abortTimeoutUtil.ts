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


/** TaggedError 的 name，也是识别它时的标记（见 isTaggedError） */
const TAGGED_ERROR_NAME = "TaggedError";


/**
 * 网关自产的打标错误：失败码与可读文案挂在错误对象上，catch 处只做提取，不按码事后生成文案。
 * 两类场景共用：
 * - 我们自己发起的 abort（超时 / 客户端断开）—— abort 的时刻信息最全（为何中止、等了多久），
 *   由 abort 方创建并作为 abort 原因（fetch 会以该错误本身 reject，undici / workerd 均如此）
 * - 响应体读取失败（上游断开等无对应 abort 的失败）—— 读取包装处创建
 * cause 可选携带底层原始错误，供日志排查用（不进对用户展示的文案）。
 *
 * 注意：本类在 workerd 下跨 fetch 边界后**原型会丢失**——workerd 会重新造一个普通 Error，
 * 只把 name 与自定义属性复制过去，`instanceof TaggedError` 因此不成立。判断一律走 isTaggedError()。
 */
export class TaggedError extends Error {
    constructor(public readonly failedCode: FailedCode, message: string, cause?: unknown) {
        super(message);
        this.name = TAGGED_ERROR_NAME;
        if (cause !== undefined) this.cause = cause;
    }
}


/**
 * 判断一个错误是不是我们打的标。
 *
 * 不能只写 `e instanceof TaggedError`：abort 的 reason 在 workerd 里穿过 fetch 边界时原型会丢，
 * workerd 用 `new Error(...)` 重建、只把 name 与自定义属性复制过去（见 workerd `jsg/util.c++`
 * 的 tunneled-error 处理），于是 instanceof 在 Worker 下恒为 false、失败码全部丢失。
 *
 * 这依赖 compat flag `enhanced_error_serialization`（workerd 默认启用日期 2026-04-21，
 * 我们 wrangler 配置里显式开启）把 name 与自定义属性带过边界；关掉该 flag 时 workerd 会把
 * 原始 name 折进 message（"TaggedError: ..."）、属性全丢，本判断随之失效。
 * 这是已知缺陷，见 cloudflare/workerd#7035。
 *
 * 非 Error 的普通值直接排除，避免把上游返回的任意对象误判成我们的失败。
 */
export function isTaggedError(e: unknown): e is TaggedError {
    return e instanceof TaggedError
        || (e instanceof Error && e.name === TAGGED_ERROR_NAME && typeof (e as TaggedError).failedCode === "string");
}


/**
 * 判断是不是「网络层失败」——即请求根本没发出去 / 没连上（连接被拒、DNS 失败、连接被重置）。
 *
 * 两个运行时给的错误形态完全不同：
 * - undici：网络失败统一是 `TypeError("fetch failed")`，真实 errno（ECONNREFUSED 等）在 e.cause 里；
 * - workerd：所有 DISCONNECTED 异常都被映射成一个**硬编码文案**的普通 Error，无 cause、无 errno
 *   （workerd `jsg/util.c++`）。文案匹配是唯一可行的判据，属已知脆弱点，见 cloudflare/workerd#7195。
 *
 * 注意这里只判「是不是网络失败」，判不出「哪种网络失败」：workerd 把拒绝连接 / DNS 失败 /
 * 连接被重置抹成了同一句话，那部分信息在 Worker 上不可得。
 */
function isNetworkError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    // undici：网络失败固定为 TypeError("fetch failed")，真实 errno 在 cause 里。
    // 必须连 message 一起判：TypeError 是通用类型错误，new URL(代理地址) 配错、
    // 代码里访问空值都会抛 TypeError，只看类型会把「代理配置错」误判成「连不上上游」
    // ——那些请求根本没发出去，是配置/代码问题，不是上游不可达。
    if (e instanceof TypeError && e.message === "fetch failed") return true;
    // workerd：所有 DISCONNECTED 异常都被映射成一个**硬编码文案**的普通 Error，无 cause、无 errno
    return e.name === "Error" && e.message === "Network connection lost.";
}


/**
 * 给「发起上游请求」阶段的失败补上失败码，供 catch 处记账与回传。
 * - 我们自己的 abort（超时 / 客户端断开）→ 原样透传，abort 现场归因最准
 * - 网络层失败 → UPSTREAM_UNREACHABLE
 * - 其余（模块加载 / 代理配置等非网络错误）→ UNKNOWN，不冒充上游不可达
 *
 * 文案一律取**原始错误**（describeError(e)），不按失败码生成：失败码只负责分类，
 * 原始错误才是排查依据。原始错误对象同时挂到 cause 上。
 */
export function classifyUpstreamFetchError(e: unknown): TaggedError {
    if (isTaggedError(e)) return e;
    const failedCode = isNetworkError(e) ? FailedCode.UPSTREAM_UNREACHABLE : FailedCode.UNKNOWN;
    return new TaggedError(failedCode, describeError(e), e);
}


/**
 * 把错误对象转成一行可读文案，供失败记录的 response_data / 活动日志 detail.error 使用：
 * - TaggedError → 直接用创建时挂上的可读文案
 * - 其他 Error → name + message，有 cause 时拼上（undici 网络错误的真实原因只在 e.cause 里，
 *   e.message 只有 "fetch failed"）
 */
function describeError(e: unknown): string {
    if (isTaggedError(e)) return e.message;
    if (!(e instanceof Error)) return String(e);
    let desc = `${e.name}: ${e.message}`;
    const cause = (e as any).cause;
    if (cause) {
        desc += `; cause: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`;
    }
    return desc;
}


/**
 * 一次封装「非流式 body 读取」的失败兜底：任何失败统一抛 TaggedError
 * （超时 / 客户端断开为透传的 abort 错误，上游断开为包装错误；failedCode 与文案都挂在错误上）。
 * 正常读完返回文本。timeoutMs <= 0 关闭超时；clientAbortSignal 可省略。
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
        // 我们打标的 abort（超时 / 客户端断开）直接透传：错误自带失败码与可读文案
        const tagged = abortCtrl.getTaggedError();
        if (tagged) throw tagged;
        // 其余为普通读取失败 → 上游断开
        throw new TaggedError(FailedCode.UPSTREAM_DISCONNECTED, "上游连接中断（响应体读取失败）");
    } finally {
        abortCtrl.dispose();
    }
}


/**
 * 合并「超时」与「客户端断连」为统一 AbortSignal。两类 abort 都以 TaggedError 作为
 * abort 原因——fetch / 读取会以该错误失败，catch 处直接从错误对象提取失败码与可读文案。
 *
 * 用法（fetch 走 signal；读 body 走 readTextWithTimeoutAndAbort 一次性兜底）：
 *   const abort = new TimeoutAbortController(timeoutMs, c.req.raw.signal);
 *   try {
 *       await fetch(url, { signal: abort.signal });
 *       const text = await readTextWithTimeoutAndAbort(res, timeoutMs, c.req.raw.signal);
 *   } catch (e) {
 *       const code = e instanceof TaggedError ? e.failedCode : null;  // 非 null 即我们的失败
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
    private tagged: TaggedError | null = null;
    private readonly timer: ReturnType<typeof setTimeout> | undefined;
    private readonly unsubscribeClient: () => void;

    constructor(timeoutMs: number, clientAbortSignal?: AbortSignal) {
        this.signal = this.controller.signal;
        if (timeoutMs > 0) {
            this.timer = setTimeout(
                () => this.abortWith(FailedCode.UPSTREAM_TIMEOUT, `上游响应超时（等待 ${timeoutMs}ms 无响应）`),
                timeoutMs,
            );
        }
        this.unsubscribeClient = onSignalAbort(clientAbortSignal, () =>
            this.abortWith(FailedCode.CLIENT_DISCONNECTED, "客户端断开连接，网关已中止上游请求"));
    }

    /** 以打标错误中止：abort 的时刻信息最全，失败码与文案都挂在错误上带出去 */
    private abortWith(failedCode: FailedCode, message: string): void {
        this.tagged = new TaggedError(failedCode, message);
        this.controller.abort(this.tagged);
    }

    /** 若本次失败由我们自己的 abort 引起，返回该错误；否则 null（普通网络错误等） */
    getTaggedError(): TaggedError | null {
        return this.tagged;
    }

    /** 清理定时器与客户端断开监听（在 finally 中调用） */
    dispose(): void {
        clearTimeout(this.timer);
        this.unsubscribeClient();
    }
}


/**
 * 流式读循环的单步读取：读一个 chunk，受相邻 chunk 空闲超时控制。读正常返回 ReadableStreamReadResult；
 * 失败抛 TaggedError（失败码与文案已挂在错误上，底层原始错误在 cause 上）：
 * - 空闲超时 → UPSTREAM_TIMEOUT（预期停顿，抛出前自动 cancel reader）
 * - 读取失败 → UPSTREAM_DISCONNECTED
 */
async function readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timedOut = false;
    try {
        return await raceWithTimeout(reader.read(), timeoutMs, () => { timedOut = true; });
    } catch (e) {
        if (timedOut) {
            reader.cancel().catch(() => {});
            throw new TaggedError(FailedCode.UPSTREAM_TIMEOUT, `上游响应超时（流式输出空闲超过 ${timeoutMs}ms）`);
        }
        throw new TaggedError(FailedCode.UPSTREAM_DISCONNECTED, "上游连接中断（流式读取失败）", e);
    }
}


export default {
    TimeoutAbortController,
    TaggedError,
    isTaggedError,
    classifyUpstreamFetchError,
    describeError,
    onSignalAbort,
    readTextWithTimeoutAndAbort,
    readChunk,
};
