const DEFAULT_MAX_SIZE = 1_000;

interface CacheEntry {
    value: unknown;
    /** 过期时刻（毫秒）；undefined = 不过期 */
    expiresAt?: number;
    /** 最后一次访问/写入时刻，用于 LRU 淘汰 */
    lastAccessAt: number;
}

// Map 的插入顺序天然是 LRU 顺序：命中时删掉再插入即可把键移到队尾
const store = new Map<string, CacheEntry>();

let maxSize = DEFAULT_MAX_SIZE;
let now: () => number = () => Date.now();

/**
 * 进程内缓存（隔离级别：每个 isolate / 进程一份）。
 *
 * ⚠️ 不要用它保存「必须跨实例一致」的状态：
 * Worker 每个 isolate 都有独立内存，见 P0-2 / P0-3 —— 限流与上游冷却已改为
 * 共享存储（D1）+ 本地短 TTL 缓存（upstreamHealthService），不再依赖本类。
 *
 * 本类只用于「单实例内的可丢失缓存」：带 TTL 与 LRU 容量上限，
 * 避免 Node 常驻模式（桌面端）下键无限增长。
 */
function purgeIfExpired(key: string, entry: CacheEntry, at: number): boolean {
    if (entry.expiresAt === undefined) {
        return false;
    }
    if (entry.expiresAt > at) {
        return false;
    }
    store.delete(key);
    return true;
}

function evictOverflow(): void {
    while (store.size > maxSize) {
        // Map 迭代顺序 = 插入顺序；队首即最久未使用
        const oldestKey = store.keys().next().value as string | undefined;
        if (oldestKey === undefined) {
            return;
        }
        store.delete(oldestKey);
    }
}

function get<T>(key: string): T | null {
    const entry = store.get(key);
    if (!entry) {
        return null;
    }
    const at = now();
    if (purgeIfExpired(key, entry, at)) {
        return null;
    }
    // LRU：命中后移到队尾
    entry.lastAccessAt = at;
    store.delete(key);
    store.set(key, entry);
    return entry.value as T;
}

function set(key: string, value: unknown, ttlMs?: number): void {
    const at = now();
    store.delete(key);
    store.set(key, {
        value,
        expiresAt: ttlMs === undefined ? undefined : at + ttlMs,
        lastAccessAt: at,
    });
    evictOverflow();
}

function del(key: string): boolean {
    return store.delete(key);
}

function has(key: string): boolean {
    const entry = store.get(key);
    if (!entry) {
        return false;
    }
    return !purgeIfExpired(key, entry, now());
}

function entries(): Array<[string, unknown]> {
    const at = now();
    const result: Array<[string, unknown]> = [];
    for (const [key, entry] of store) {
        if (!purgeIfExpired(key, entry, at)) {
            result.push([key, entry.value]);
        }
    }
    return result;
}

function clear(): void {
    store.clear();
}

/** 当前条目数（测试/可观测性用） */
function size(): number {
    return store.size;
}

/**
 * 配置容量上限与时钟（测试用）。
 * @param options.maxSize 最多保留的键数，超出按 LRU 淘汰
 * @param options.now 自定义时钟，便于测试 TTL
 */
function configure(options: { maxSize?: number; now?: () => number }): void {
    if (options.maxSize !== undefined) {
        maxSize = Math.max(1, options.maxSize);
        evictOverflow();
    }
    if (options.now) {
        now = options.now;
    }
}

/** 清理所有已过期条目（返回清理数量） */
function pruneExpired(): number {
    const at = now();
    let removed = 0;
    for (const [key, entry] of store) {
        if (purgeIfExpired(key, entry, at)) {
            removed++;
        }
    }
    return removed;
}

export default {
    get,
    set,
    del,
    has,
    entries,
    clear,
    size,
    configure,
    pruneExpired,
};
