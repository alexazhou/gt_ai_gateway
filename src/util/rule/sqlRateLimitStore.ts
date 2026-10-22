import type { ConsumeResult, RateLimitStore } from "./types";
import type { SqlExecutor } from "./sqlExecutor";

// 惰性清扫概率：命中限流键的写入路径上偶发一次，避免每次请求都多一条 DELETE
const CLEANUP_PROBABILITY = 0.01;

/**
 * SQL 令牌桶限流存储（Worker / D1 用）。
 *
 * 解决的问题（P0-2）：内存令牌桶在每个 isolate 各一份，N 个 isolate 等于把 rpm 放大 N 倍。
 * 现在桶状态落库，跨 isolate 共享；扣减是**单条带条件的原子 UPDATE**，
 * 靠数据库的行级原子性保证并发请求不会超发。
 *
 * 方言：使用 SQLite 标量 `MIN(a,b)` / `MAX(a,b)` 与 `RETURNING`（D1 与 better-sqlite3 都支持）。
 * MySQL 的 MIN/MAX 是聚合函数且不支持 RETURNING，因此本实现只用于 worker/D1；
 * Node + MySQL 模式仍走内存实现（单进程内天然正确）。
 */
export class SqlRateLimitStore implements RateLimitStore {
    constructor(private executor: SqlExecutor) {}

    async consume(key: string, now: number, capacity: number, refillPerMs: number): Promise<ConsumeResult> {
        // ① 首次见到该键：以满桶初始化（并发下由主键冲突忽略，幂等）
        await this.executor.run(
            "INSERT INTO rate_limit_bucket (bucket_key, tokens, last_ms) VALUES (?, ?, ?) ON CONFLICT(bucket_key) DO NOTHING",
            [key, capacity, now],
        );

        // ② 单语句完成「补液 + 扣 1」：WHERE 里的余量判断与 SET 里的扣减在同一行锁内完成，
        //    并发请求只有一个能扣到，其余影响 0 行 → 判定限流。
        //    参数顺序与 SQL 中的问号出现顺序一致（capacity, now, refill, now, key, now, refill）。
        const updated = await this.executor.all<{ tokens: number }>(
            `UPDATE rate_limit_bucket
                SET tokens = MIN(?, tokens + MAX(0, ? - last_ms) * ?) - 1,
                    last_ms = ?
              WHERE bucket_key = ?
                AND tokens + MAX(0, ? - last_ms) * ? >= 1
              RETURNING tokens`,
            [capacity, now, refillPerMs, now, key, now, refillPerMs],
        );

        if (updated.length > 0) {
            this.maybeCleanup(now);
            return { allowed: true, remaining: Number(updated[0].tokens) };
        }

        // ③ 未扣到：读回当前桶算剩余量（供 Retry-After 精确计算）
        const rows = await this.executor.all<{ tokens: number; last_ms: number }>(
            "SELECT tokens, last_ms FROM rate_limit_bucket WHERE bucket_key = ?",
            [key],
        );
        this.maybeCleanup(now);

        if (rows.length === 0) {
            // 行在 ② 之前被清扫/删除：按空桶处理（保守拒绝，下一个请求会重新初始化）
            return { allowed: false, remaining: 0 };
        }

        const tokens = Number(rows[0].tokens);
        const lastMs = Number(rows[0].last_ms);
        const remaining = Math.min(capacity, tokens + Math.max(0, now - lastMs) * refillPerMs);
        return { allowed: false, remaining };
    }

    /**
     * 惰性清扫：令牌桶空闲后会补满并停在容量，回收后重建仍从满桶开始，等价于保留。
     * 按概率触发，避免每条请求都多出一次写。
     */
    private maybeCleanup(now: number): void {
        if (Math.random() >= CLEANUP_PROBABILITY) {
            return;
        }
        // 空闲超过 10 分钟即回收（远大于补满所需时间，不影响语义）
        void this.executor
            .run("DELETE FROM rate_limit_bucket WHERE last_ms < ?", [now - 10 * 60_000])
            .catch((e) => console.warn("[SqlRateLimitStore] cleanup failed:", e));
    }
}

export default SqlRateLimitStore;
