import type { SqlExecutor } from "../rule/sqlExecutor";

/** 一条上游冷却记录 */
export interface UpstreamHealthRecord {
    key: string;
    failedAt: number;
}

/**
 * 上游冷却状态的持久化存储接口（P0-3）。
 *
 * Worker 每个 isolate 各有一份内存，冷却状态必须落库才能跨 isolate 生效；
 * Node 模式单进程内内存即事实来源，不需要持久化（store 为 null）。
 */
export interface UpstreamHealthStore {
    markFailure(key: string, failedAt: number): Promise<void> | void;
    /** 取出 failedAt >= sinceMs 的记录（用于周期性同步到 isolate 本地缓存） */
    listFailuresSince(sinceMs: number): Promise<UpstreamHealthRecord[]> | UpstreamHealthRecord[];
    /** 删除 failedAt < beforeMs 的过期记录 */
    prune(beforeMs: number): Promise<void> | void;
    clear(): Promise<void> | void;
}

/**
 * SQL 实现（Worker / D1）：`upstream_health` 表，主键 health_key。
 * 读放大用 isolate 本地短 TTL 缓存压住（见 upstreamHealthService），
 * 这里只负责「写」与「周期性全量拉取」。
 */
export class SqlUpstreamHealthStore implements UpstreamHealthStore {
    constructor(private executor: SqlExecutor) {}

    async markFailure(key: string, failedAt: number): Promise<void> {
        await this.executor.run(
            "INSERT INTO upstream_health (health_key, failed_at) VALUES (?, ?) ON CONFLICT(health_key) DO UPDATE SET failed_at = excluded.failed_at",
            [key, failedAt],
        );
    }

    async listFailuresSince(sinceMs: number): Promise<UpstreamHealthRecord[]> {
        const rows = await this.executor.all<{ health_key: string; failed_at: number }>(
            "SELECT health_key, failed_at FROM upstream_health WHERE failed_at >= ?",
            [sinceMs],
        );
        return rows.map((row) => ({ key: row.health_key, failedAt: Number(row.failed_at) }));
    }

    async prune(beforeMs: number): Promise<void> {
        await this.executor.run("DELETE FROM upstream_health WHERE failed_at < ?", [beforeMs]);
    }

    async clear(): Promise<void> {
        await this.executor.run("DELETE FROM upstream_health");
    }
}

export default SqlUpstreamHealthStore;
