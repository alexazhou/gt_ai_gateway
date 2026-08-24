import type { ConsumeResult, RateLimitStore } from "./types";

// rpm 的补液窗口：1 分钟（rpm = requests per minute，补液速率 = rpm / 60s）
const WINDOW_MS = 60_000;
// 惰性清扫触发间隔：两次活跃调用（consume）相隔超过该值即清扫一次
const CLEANUP_INTERVAL_MS = 60_000;
// 键空闲超过该时长即回收（重建后从满桶开始，等效于全新窗口全额额度）
const MAX_IDLE_MS = 120_000;

// 单条计数器的令牌桶状态：当前令牌数 + 最后一次补液时刻
interface TokenBucket {
    tokens: number;
    lastRefill: number;
}

/**
 * 内存令牌桶（Token Bucket）限流计数器：
 * - 桶容量 capacity = rpm（瞬时突发上限），补液速率 refillPerMs = rpm / 60s（每分钟补满 rpm 个令牌）
 * - 每个请求扣 1 个令牌，桶空即限流；补液按毫秒连续累计，无固定两桶插值，不产生估计误差
 * - 长时间平均速率收敛到 N 请求/分钟，瞬时突发 ≤ N，语义清晰且可给出精确的等待重试时间
 *
 * Node 单进程事件循环内同步读写天然原子，无并发问题。键空间按（规则数 × 上限）有界，
 * 配 consume 内的惰性清扫回收陈旧键（避免常驻定时器在 Worker 全局作用域下报错）。
 */
class MemoryRateLimitStore implements RateLimitStore {
    private buckets = new Map<string, TokenBucket>();
    private lastCleanup = 0;

    /** 补液 + 扣 1 个令牌；桶空返回 allowed=false（不扣减，令牌保持当前值） */
    consume(key: string, now: number, capacity: number, refillPerMs: number): ConsumeResult {
        // 定期惰性清扫陈旧键（空闲超过 MAX_IDLE_MS），避免常驻定时器在 Worker 全局作用域下报错
        if (this.lastCleanup === 0 || now - this.lastCleanup >= CLEANUP_INTERVAL_MS) {
            this.cleanup(now);
            this.lastCleanup = now;
        }

        let bucket = this.buckets.get(key);
        if (!bucket) {
            // 新键从满桶开始：等效于新窗口直接获得全额 rpm 额度
            bucket = { tokens: capacity, lastRefill: now };
            this.buckets.set(key, bucket);
        }

        // 补液：按经过时间补充令牌，封顶到容量；lastRefill 推进到 now，避免下次重复累计
        const elapsed = now - bucket.lastRefill;
        if (elapsed > 0) {
            bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
            bucket.lastRefill = now;
        }

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return { allowed: true, remaining: bucket.tokens };
        }
        return { allowed: false, remaining: bucket.tokens };
    }


    /**
     * 清扫陈旧键：空闲超过 MAX_IDLE_MS 即回收。令牌桶空闲时自然补满并停在容量，
     * 回收后重建仍从满桶开始，与保留等价（键空间按（规则数 × 上限）有界）。
     */
    cleanup(now: number): void {
        for (const [key, bucket] of this.buckets) {
            if (now - bucket.lastRefill >= MAX_IDLE_MS) {
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