import {
    StateStoreUnavailableError,
    type CasOptions,
    type ConsumeOptions,
    type ConsumeResult,
    type IncrByOptions,
    type IncrByResult,
    type SetOptions,
    type StateStore,
    type TimeOptions,
} from "./types";

// ---------------------------------------------------------------------------
// 内存实现（node / 桌面模式）
//
// 原子性前提：JS 单线程 + 每个方法的执行体内**不出现「读快照 → await → 写回」**，
// 整段「读-改-写」跑在一个同步块里，不会被切走 —— 这是 memory 后端满足
// consume / incrBy / compareAndSet 原子语义的唯一依据。
// 方法签名是 async 只是为了与 DO / Redis 的调用形态一致；真正危险的是在读写之间插入等待
// （DO 无条件读 → 网络往返 → 写的典型形态）：那样 50 个并发会互相覆盖快照、全部放行。
// 下面的并发反证（50 并发 capacity=10 必须恰好 10 放行）就是这条防线的安检门，
// 已用「读快照 → await → 写回」的变异体验证过它会变红。
// 换到 Durable Object / Redis 时这条前提不成立，实现方必须用事务 / Lua 自己保证，
// 接口层面的语义契约不变。
//
// 令牌一律用**整数毫令牌**（1 令牌 = 1000 毫令牌）存储与累加，不做浮点累加——
// 理由同设计 §8（DO 里同样用整数）：浮点累加在 0.1 这类速率下会攒出可见误差，
// 限流误差直接等于多放行 / 误拒。Math.floor 只出现在「把调用方传入的浮点令牌数、
// 或一段时间内累计的补液量折算成整毫令牌」这两处，且补液余数会被保留（见 refill）。
// ---------------------------------------------------------------------------

/** 1 个令牌 = 1000 毫令牌 */
const TOKENS_PER_UNIT = 1000;

/** 键数上界缺省值：超过即触发「先回收、再拒绝」（无界增长 = 内存泄漏） */
const DEFAULT_MAX_KEYS = 10_000;
/** 空转满桶的空闲回收阈值，与 src/util/rule/memoryRateLimitStore.ts 的 MAX_IDLE_MS 对齐 */
const DEFAULT_IDLE_EVICT_MS = 120_000;
/** 惰性清扫间隔：两次活跃调用间隔超过该值即清扫一次（不挂常驻定时器，Worker 全局作用域不允许） */
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

/** 令牌桶状态：全部整数（毫令牌） */
interface BucketState {
    /** 当前令牌（毫令牌） */
    tokensMilli: number;
    /** 桶容量（毫令牌），随调用方最新参数更新 */
    capacityMilli: number;
    /** 补液速率（毫令牌/毫秒），随调用方最新参数更新；清扫时用它推算「此刻是否已回满」 */
    rateMilliPerMs: number;
    /**
     * 上一次「已折算成整毫令牌」的补液时刻。
     * 关键：只推进已折算的部分，不足 1 毫令牌的时间余数留到下次，
     * 否则高频调用下每次 Math.floor 都丢一点，低 rpm 时误差会放大成倍。
     */
    updatedAtMs: number;
}

/**
 * 统一键空间条目：令牌桶、计数器、纯可丢缓存共用一个 Map。
 * 共用是为了让「同一个 key 被两种语义使用」变成显式报错，
 * 而不是各存一份、互相看不见（那会变成很难查的别名 bug）。
 */
type StoredEntry =
    | { kind: "bucket"; bucket: BucketState }
    | { kind: "counter"; value: number; expiresAtMs: number | null }
    | { kind: "cache"; value: string; expiresAtMs: number | null };

/** 内存实现的可调参数（生产用缺省值；测试用小值验证上界与回收逻辑） */
export interface MemoryStateStoreOptions {
    /** 键数上界（令牌桶 + 计数器 + 缓存条目合计） */
    maxKeys?: number;
    /** 空转满桶的空闲回收阈值（毫秒） */
    idleEvictMs?: number;
    /** 惰性清扫间隔（毫秒） */
    cleanupIntervalMs?: number;
}

/**
 * 内存 StateStore：node / 桌面模式的实现，也是跨实现契约测试的第一个靶子。
 *
 * 键数与淘汰策略（重要）：
 * - 正常回收只做**语义等价**的两件事：① 删除已过期的计数器 / 缓存条目（这两类本来就带 TTL）；
 *   ② 删除「已经回满且长时间没被访问」的令牌桶 —— 空转的桶必然停在满桶，
 *   留着的效果与删掉后重建（也是满桶）完全一致，所以这一步不改变任何可观测行为。
 * - 因此本实现**绝不**淘汰「还有令牌被消耗过的桶」：那等于凭空发额度，是放行变多。
 * - 代价是键数可能真的顶到上界（key 里带用户 ID 且不配 TTL 时最容易发生）。
 *   顶到上界后的行为是显式的：consume 返回 allowed=false（限流 fail-closed），
 *   其它写操作抛 StateStoreUnavailableError（写失败无法用 boolean 表达，必须显式报错）。
 *   上界保护只保证「不会无限吃内存」，它不能替调用方修 key 设计；日志会打一次告警。
 */
export class MemoryStateStore implements StateStore {
    private readonly store = new Map<string, StoredEntry>();
    private readonly maxKeys: number;
    private readonly idleEvictMs: number;
    private readonly cleanupIntervalMs: number;
    private lastCleanupMs = 0;
    private warnedAtCapacity = false;

    constructor(options: MemoryStateStoreOptions = {}) {
        this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
        this.idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
        this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
        if (!Number.isInteger(this.maxKeys) || this.maxKeys <= 0) {
            throw new RangeError(`MemoryStateStore: maxKeys 必须为正整数，收到 ${this.maxKeys}`);
        }
        if (!Number.isFinite(this.idleEvictMs) || this.idleEvictMs < 0) {
            throw new RangeError(`MemoryStateStore: idleEvictMs 必须为有限非负数，收到 ${this.idleEvictMs}`);
        }
        if (!Number.isFinite(this.cleanupIntervalMs) || this.cleanupIntervalMs <= 0) {
            throw new RangeError(`MemoryStateStore: cleanupIntervalMs 必须为有限正数，收到 ${this.cleanupIntervalMs}`);
        }
    }

    // 注意：以下方法体内不得出现 await（原子性前提见文件头注释）
    async consume(key: string, options: ConsumeOptions): Promise<ConsumeResult> {
        const nowMs = options.nowMs ?? Date.now();
        const capacityMilli = toMilliTokens(options.capacity, "capacity", true);
        const costMilli = toMilliTokens(options.cost ?? 1, "cost", false);
        if (!Number.isFinite(options.refillPerSec) || options.refillPerSec < 0) {
            throw new RangeError(`StateStore.consume: refillPerSec 必须为有限非负数，收到 ${options.refillPerSec}`);
        }
        // 令牌/秒 × 1000 毫令牌/令牌 ÷ 1000 毫秒/秒 = 毫令牌/毫秒，数值上恰好等于 refillPerSec
        const rateMilliPerMs = options.refillPerSec;

        this.maybeSweep(nowMs);

        const existing = this.store.get(key);
        let bucket: BucketState;
        if (!existing) {
            if (!this.admitNewKey(nowMs)) {
                // 键数上界：fail-closed（拒绝放行）。不抛异常，保证限流只有一条判定出口。
                return { allowed: false, remaining: 0, retryAfterMs: null };
            }
            // 新键从满桶开始：等效于新窗口直接拿到全额额度
            bucket = { tokensMilli: capacityMilli, capacityMilli, rateMilliPerMs, updatedAtMs: nowMs };
            this.store.set(key, { kind: "bucket", bucket });
        } else if (existing.kind === "bucket") {
            bucket = existing.bucket;
            bucket.rateMilliPerMs = rateMilliPerMs;
            if (bucket.capacityMilli !== capacityMilli) {
                // 同一 key 的 capacity 变更：以最新参数为准，并把余额裁到新容量。
                // 只裁不补 —— 容量放大时凭空补满会多放行。
                bucket.capacityMilli = capacityMilli;
                bucket.tokensMilli = Math.min(bucket.tokensMilli, capacityMilli);
            }
        } else {
            throw new TypeError(crossSemanticMessage("consume", key, existing.kind, "令牌桶"));
        }

        this.refill(bucket, nowMs, rateMilliPerMs);

        if (bucket.tokensMilli >= costMilli) {
            bucket.tokensMilli -= costMilli;
            return { allowed: true, remaining: bucket.tokensMilli / TOKENS_PER_UNIT, retryAfterMs: 0 };
        }
        return {
            allowed: false,
            remaining: bucket.tokensMilli / TOKENS_PER_UNIT,
            retryAfterMs: this.computeRetryAfterMs(bucket, costMilli, rateMilliPerMs),
        };
    }

    async incrBy(key: string, delta: number, options: IncrByOptions = {}): Promise<IncrByResult> {
        if (!Number.isFinite(delta)) {
            throw new RangeError(`StateStore.incrBy: delta 必须为有限数字，收到 ${delta}`);
        }
        const ttlMs = normalizeTtl(options.ttlMs, "incrBy");
        const nowMs = options.nowMs ?? Date.now();
        this.maybeSweep(nowMs);

        const entry = this.readLive(key, nowMs);
        if (!entry) {
            this.admitNewKeyOrThrow(nowMs, "incrBy");
            const expiresAtMs = ttlMs === null ? null : nowMs + ttlMs;
            this.store.set(key, { kind: "counter", value: delta, expiresAtMs });
            return { value: delta, resetAt: expiresAtMs };
        }
        if (entry.kind !== "counter") {
            throw new TypeError(crossSemanticMessage("incrBy", key, entry.kind, "计数器"));
        }
        // 窗口内单调累加：resetAt 不变（窗口不因访问而续期）
        const value = entry.value + delta;
        this.store.set(key, { kind: "counter", value, expiresAtMs: entry.expiresAtMs });
        return { value, resetAt: entry.expiresAtMs };
    }

    async compareAndSet(key: string, expected: string | null, next: string, options: CasOptions = {}): Promise<boolean> {
        assertCacheValue(next, "next");
        if (expected !== null) assertCacheValue(expected, "expected");
        const ttlMs = normalizeTtl(options.ttlMs, "compareAndSet");
        const nowMs = options.nowMs ?? Date.now();
        this.maybeSweep(nowMs);

        const entry = this.readLive(key, nowMs);
        if (entry && entry.kind !== "cache") {
            throw new TypeError(crossSemanticMessage("compareAndSet", key, entry.kind, "纯可丢缓存"));
        }
        const cache = entry?.kind === "cache" ? entry : null;

        if (expected === null) {
            // 三态之一：expected=null 表示「键不存在才写」（建键 / 抢占锁）
            if (cache) return false;
            this.admitNewKeyOrThrow(nowMs, "compareAndSet");
            this.store.set(key, { kind: "cache", value: next, expiresAtMs: ttlMs === null ? null : nowMs + ttlMs });
            return true;
        }
        if (!cache) return false;
        if (cache.value !== expected) return false;
        // 写入成功：给了 ttlMs 就重置过期时刻，没给则沿用原有过期时刻
        const expiresAtMs = ttlMs === null ? cache.expiresAtMs : nowMs + ttlMs;
        this.store.set(key, { kind: "cache", value: next, expiresAtMs });
        return true;
    }

    async get(key: string, options: TimeOptions = {}): Promise<string | null> {
        const entry = this.readLive(key, options.nowMs ?? Date.now());
        if (!entry) return null;
        if (entry.kind !== "cache") {
            throw new TypeError(crossSemanticMessage("get", key, entry.kind, "纯可丢缓存"));
        }
        return entry.value;
    }

    async set(key: string, value: string, options: SetOptions = {}): Promise<void> {
        assertCacheValue(value, "value");
        const ttlMs = normalizeTtl(options.ttlMs, "set");
        const nowMs = options.nowMs ?? Date.now();
        this.maybeSweep(nowMs);

        const existing = this.store.get(key);
        if (existing && existing.kind !== "cache") {
            throw new TypeError(crossSemanticMessage("set", key, existing.kind, "纯可丢缓存"));
        }
        if (!existing) {
            this.admitNewKeyOrThrow(nowMs, "set");
        }
        this.store.set(key, { kind: "cache", value, expiresAtMs: ttlMs === null ? null : nowMs + ttlMs });
    }

    async delete(key: string): Promise<boolean> {
        const existing = this.store.get(key);
        if (existing && existing.kind !== "cache") {
            throw new TypeError(
                `StateStore.delete: key "${key}" 属于${kindLabel(existing.kind)}语义，不能当纯可丢缓存删除` +
                    `（删桶等于凭空发额度）；要重置请换一个独立 key`,
            );
        }
        return this.store.delete(key);
    }

    /** 当前键数（令牌桶 + 计数器 + 缓存，可观测性 / 测试用；不属于 StateStore 接口） */
    size(): number {
        return this.store.size;
    }

    /**
     * 补液：把经过时间折算成整毫令牌，封顶到容量。
     * 折算不足 1 毫令牌的时间余数通过回退 updatedAtMs 保留到下次（避免高频截断丢量）。
     */
    private refill(bucket: BucketState, nowMs: number, rateMilliPerMs: number): void {
        if (rateMilliPerMs <= 0) return; // 只出不进：桶不会被补满，也不再推进时间锚点
        const elapsedMs = nowMs - bucket.updatedAtMs;
        if (elapsedMs <= 0) return; // 同一时刻重复调用 / 时钟回拨：不补液
        const accruedMilli = Math.floor(elapsedMs * rateMilliPerMs);
        if (accruedMilli <= 0) return; // 还不足 1 毫令牌，留着下次一起折算
        bucket.tokensMilli = Math.min(bucket.capacityMilli, bucket.tokensMilli + accruedMilli);
        const leftoverMs = Math.floor((elapsedMs * rateMilliPerMs - accruedMilli) / rateMilliPerMs);
        bucket.updatedAtMs = nowMs - leftoverMs;
    }

    /** 拒绝时给出精确等待时间；永远等不到时返回 null（口径见 ConsumeResult.retryAfterMs） */
    private computeRetryAfterMs(bucket: BucketState, costMilli: number, rateMilliPerMs: number): number | null {
        if (rateMilliPerMs <= 0) return null;
        if (bucket.capacityMilli < costMilli) return null;
        const needMilli = costMilli - bucket.tokensMilli;
        // 减去极小量抵消浮点除法噪声（1000/0.05 这类会算出 20000.000000000004，
        // 直接 ceil 会多等 1ms）；1e-9ms 远小于任何真实需求，不影响向上取整的语义。
        return Math.ceil(needMilli / rateMilliPerMs - 1e-9);
    }

    /** 惰性清扫触发：到间隔就扫一次；时钟回拨时重置锚点，避免永久不再清扫（否则等于内存泄漏） */
    private maybeSweep(nowMs: number): void {
        if (this.lastCleanupMs === 0 || nowMs - this.lastCleanupMs >= this.cleanupIntervalMs || nowMs < this.lastCleanupMs) {
            this.sweep(nowMs);
            this.lastCleanupMs = nowMs;
        }
    }

    /** 语义等价回收：过期计数器 / 缓存 + 空转满桶（见类注释，不减放行额度） */
    private sweep(nowMs: number): void {
        for (const [key, entry] of this.store) {
            if (entry.kind === "bucket") {
                // 用「按存储的速率推算到此刻」的令牌数判断是否已回满：
                // 空转的桶不会有人来补液，只看存量的 tokensMilli 会永远判不出「满」，
                // 这条回收规则就成了死代码（初版踩过）。速率与容量只允许同一 key 恒定，
                // 因此推算与真实补液结果一致。
                const idleMs = nowMs - entry.bucket.updatedAtMs;
                const projectedMilli =
                    entry.bucket.tokensMilli + Math.floor(Math.max(0, idleMs) * entry.bucket.rateMilliPerMs);
                if (projectedMilli >= entry.bucket.capacityMilli && idleMs >= this.idleEvictMs) {
                    this.store.delete(key);
                }
                continue;
            }
            if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
                this.store.delete(key);
            }
        }
        if (this.store.size < this.maxKeys) this.warnedAtCapacity = false;
    }

    /** 新键准入：先做一次语义等价回收，仍满则拒绝（返回 false） */
    private admitNewKey(nowMs: number): boolean {
        if (this.store.size < this.maxKeys) return true;
        this.sweep(nowMs);
        this.lastCleanupMs = nowMs;
        if (this.store.size < this.maxKeys) return true;
        if (!this.warnedAtCapacity) {
            this.warnedAtCapacity = true;
            console.warn(
                `[MemoryStateStore] 键数已达上界 maxKeys=${this.maxKeys}：新键一律拒绝（限流 fail-closed / 其它写操作抛错）。` +
                    "请检查 key 是否无界增长（含用户 ID 的 key 必须配 TTL，或改用 incrBy 的窗口语义）。",
            );
        }
        return false;
    }

    /** 非 consume 的写操作准入：满了就显式报错（写失败无法用 boolean 表达，必须让调用方感知） */
    private admitNewKeyOrThrow(nowMs: number, op: string): void {
        if (this.admitNewKey(nowMs)) return;
        throw new StateStoreUnavailableError(
            `StateStore.${op}: 键数已达上界 maxKeys=${this.maxKeys}，拒绝写入新键（显式报错，不静默丢弃）`,
        );
    }

    /** 读「活着的」条目：过期的计数器 / 缓存即惰性回收并当作不存在 */
    private readLive(key: string, nowMs: number): StoredEntry | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.kind === "bucket") return entry;
        if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
            this.store.delete(key);
            return null;
        }
        return entry;
    }
}

/** 语义标签（报错文案用） */
function kindLabel(kind: StoredEntry["kind"]): string {
    switch (kind) {
        case "bucket":
            return "令牌桶";
        case "counter":
            return "计数器";
        case "cache":
            return "纯可丢缓存";
    }
}

/** 跨语义访问的统一报错：同一个 key 混用两种语义是调用方 bug，必须显式暴露 */
function crossSemanticMessage(op: string, key: string, actual: StoredEntry["kind"], expected: string): string {
    return `StateStore.${op}: key "${key}" 当前属于${kindLabel(actual)}语义，不能按${expected}使用（同一个 key 只能归属一种语义）`;
}

/** 把调用方的令牌数折算成整毫令牌（唯一的浮点入口，口径见文件头注释） */
function toMilliTokens(value: number, name: string, allowZero: boolean): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`StateStore.consume: ${name} 必须为有限数字，收到 ${value}`);
    }
    if (value < 0 || (!allowZero && value === 0)) {
        throw new RangeError(`StateStore.consume: ${name} 必须${allowZero ? "为非负数" : "为正数"}，收到 ${value}`);
    }
    return Math.floor(value * TOKENS_PER_UNIT);
}

/** TTL 校验：undefined = 无 TTL（返回 null），否则必须为有限正数 */
function normalizeTtl(ttlMs: number | undefined, op: string): number | null {
    if (ttlMs === undefined) return null;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError(`StateStore.${op}: ttlMs 必须为有限正数，收到 ${ttlMs}`);
    }
    return ttlMs;
}

/** 缓存值必须是 string：null 已用于表示「键不存在」，其它类型跨后端语义无法对齐（见 types.ts 约定 B） */
function assertCacheValue(value: unknown, name: string): void {
    if (typeof value !== "string") {
        throw new TypeError(
            `StateStore: ${name} 必须为 string（收到 ${value === null ? "null" : typeof value}）` +
                "；结构化值请调用方自行 JSON 编码",
        );
    }
}
