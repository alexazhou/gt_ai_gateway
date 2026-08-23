import type { RateLimitStore } from "./types";

// 限流窗口：60s 滑动窗口
const WINDOW_MS = 60_000;
// 陈旧键清扫间隔阈值：两次活跃调用（incr）相隔超过该值即惰性触发一次清扫
const CLEANUP_INTERVAL_MS = 60_000;

// 单条计数器的两桶状态：当前分钟 + 上一分钟（用于跨分钟边界的加权插值）
interface WindowBucket {
    minuteKey: number;
    curCount: number;
    prevCount: number;
}

/**
 * 内存滑动窗口计数器（60s 窗口 + 当前/上一分钟两桶加权插值），避免固定窗口在分钟交界的双倍突发：
 * weighted = curCount + prevCount * (1 - elapsed / 60_000)
 *
 * Node 单进程事件循环内同步读写天然原子，无并发问题。键空间按（规则数 × 2 分钟窗口）有界，
 * 配 incr 内的惰性清扫回收陈旧键（避免常驻定时器在 Worker 全局作用域下报错）。
 */
class MemoryRateLimitStore implements RateLimitStore {
    private buckets = new Map<string, WindowBucket>();
    private lastCleanup = 0;

    /** 自增 1 并返回加权计数（RPM：check + record 一步完成） */
    incr(key: string, now: number): number {
        // 定期惰性清扫陈旧键（空闲超过 1 个完整窗口），避免常驻定时器在 Worker 全局作用域下报错
        if (this.lastCleanup === 0 || now - this.lastCleanup >= CLEANUP_INTERVAL_MS) {
            this.cleanup(now);
            this.lastCleanup = now;
        }

        const minuteKey = Math.floor(now / WINDOW_MS);

        let bucket = this.buckets.get(key);
        if (!bucket) {
            bucket = { minuteKey, curCount: 0, prevCount: 0 };
            this.buckets.set(key, bucket);
        }

        // 滚动到新分钟：相邻分钟把当前计数降级为上一分钟；跨多个窗口则上一分钟清零
        if (bucket.minuteKey !== minuteKey) {
            if (minuteKey - bucket.minuteKey === 1) {
                bucket.prevCount = bucket.curCount;
            } else {
                bucket.prevCount = 0;
            }
            bucket.curCount = 0;
            bucket.minuteKey = minuteKey;
        }

        bucket.curCount += 1;

        const elapsed = now - minuteKey * WINDOW_MS;
        return bucket.curCount + bucket.prevCount * (1 - elapsed / WINDOW_MS);
    }


    /**
     * 清扫陈旧键：最后一次活跃早于上一分钟（空闲超过 1 个完整窗口）即回收。
     * 键空间按（规则数 × 2 分钟窗口）有界——活跃键的 minuteKey 只可能是当前分钟或上一分钟，
     * 空闲 2 分钟以上的键数据已完全过期，回收无害。
     */
    cleanup(now: number): void {
        const currentMinuteKey = Math.floor(now / WINDOW_MS);
        for (const [key, bucket] of this.buckets) {
            if (currentMinuteKey - bucket.minuteKey > 1) {
                this.buckets.delete(key);
            }
        }
    }


    /** 当前键数量（测试/可观测性用） */
    size(): number {
        return this.buckets.size;
    }


    /** 清空所有计数器（测试隔离用） */
    clear(): void {
        this.buckets.clear();
        this.lastCleanup = 0;
    }
}

const store = new MemoryRateLimitStore();

export default store;
