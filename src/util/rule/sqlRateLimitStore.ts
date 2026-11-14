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
 *
 * 写次数（P2-25）：**放行快路径只有 1 条写**。原来每次放行都先跑一条
 * `INSERT ... ON CONFLICT DO NOTHING`（几乎必然是主键冲突的无用写）再 UPDATE，D1 上写放大翻倍；
 * 现在改成「先 UPDATE → 0 行时再读一次区分『桶不存在』与『令牌不足』→ 只有缺桶才 INSERT 后重试」，
 * 桶存在时（稳态）不会产生任何多余写。
 */
export class SqlRateLimitStore implements RateLimitStore {
    constructor(private executor: SqlExecutor) {}

    /** 补液 + 扣 1 的单条原子 UPDATE；返回改后的行（余量不足/桶不存在时返回空数组） */
    private async decrement(
        key: string,
        now: number,
        capacity: number,
        refillPerMs: number,
    ): Promise<Array<{ tokens: number }>> {
        // WHERE 里的余量判断与 SET 里的扣减在同一行锁内完成，
        // 并发请求只有一个能扣到，其余影响 0 行 → 判定限流。
        // 参数顺序与 SQL 中问号出现顺序一致（capacity, now, refill, now, key, now, refill）。
        return await this.executor.all<{ tokens: number }>(
            `UPDATE rate_limit_bucket
                SET tokens = MIN(?, tokens + MAX(0, ? - last_ms) * ?) - 1,
                    last_ms = ?
              WHERE bucket_key = ?
                AND tokens + MAX(0, ? - last_ms) * ? >= 1
              RETURNING tokens`,
            [capacity, now, refillPerMs, now, key, now, refillPerMs],
        );
    }

    private async readBucket(key: string): Promise<{ tokens: number; last_ms: number } | null> {
        const rows = await this.executor.all<{ tokens: number; last_ms: number }>(
            "SELECT tokens, last_ms FROM rate_limit_bucket WHERE bucket_key = ?",
            [key],
        );
        return rows.length > 0 ? rows[0] : null;
    }

    /** 按「补液后封顶容量」算剩余量（供 Retry-After 精确计算） */
    private remainingOf(
        row: { tokens: number; last_ms: number },
        now: number,
        capacity: number,
        refillPerMs: number,
    ): number {
        const tokens = Number(row.tokens);
        const lastMs = Number(row.last_ms);
        return Math.min(capacity, tokens + Math.max(0, now - lastMs) * refillPerMs);
    }

    async consume(key: string, now: number, capacity: number, refillPerMs: number): Promise<ConsumeResult> {
        // ① 快路径：桶已存在时一条 UPDATE 完成补液 + 扣减（放行只需 1 次写）
        const updated = await this.decrement(key, now, capacity, refillPerMs);
        if (updated.length > 0) {
            this.maybeCleanup(now);
            return { allowed: true, remaining: Number(updated[0].tokens) };
        }

        // ② 0 行：桶不存在，或令牌不足 —— 读一次区分（读不产生写放大）
        const existing = await this.readBucket(key);
        if (!existing) {
            // ③ 首次见到该键（或桶刚被惰性清扫）：以满桶初始化后重试一次。
            //    并发下多个请求可能同时走到这里，由主键冲突忽略（幂等），
            //    重试的 UPDATE 仍只有一条能扣到。
            await this.executor.run(
                "INSERT INTO rate_limit_bucket (bucket_key, tokens, last_ms) VALUES (?, ?, ?) ON CONFLICT(bucket_key) DO NOTHING",
                [key, capacity, now],
            );
            const retried = await this.decrement(key, now, capacity, refillPerMs);
            this.maybeCleanup(now);
            if (retried.length > 0) {
                return { allowed: true, remaining: Number(retried[0].tokens) };
            }
            const after = await this.readBucket(key);
            return { allowed: false, remaining: after ? this.remainingOf(after, now, capacity, refillPerMs) : 0 };
        }

        // ④ 桶存在但余量不足：直接拒绝（不写库，被拒请求不扣减）
        this.maybeCleanup(now);
        return { allowed: false, remaining: this.remainingOf(existing, now, capacity, refillPerMs) };
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
