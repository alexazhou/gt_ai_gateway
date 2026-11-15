/**
 * 最小 SQL 执行器抽象（跨驱动）。
 *
 * 为什么需要它：Worker 的 D1 / Node 的 better-sqlite3 / MySQL 的 prepare 语义不同，
 * 而「跨 isolate 共享状态」的两个存储（限流令牌桶、上游冷却）只需要两条能力：
 * 执行写语句拿到影响行数、执行查询拿到行数组。
 *
 * 实现放在 service 层（src/service/sqlExecutorService.ts），这里只定义契约，
 * 便于单测用内存/临时 SQLite 注入，不依赖 ormService。
 */
export interface SqlExecutionResult {
    /** 受影响行数（D1 meta.changes / better-sqlite3 changes / mysql affectedRows） */
    changes: number;
}

export interface SqlExecutor {
    run(sql: string, params?: unknown[]): Promise<SqlExecutionResult>;
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export default {
    // 类型占位，便于 `import type { SqlExecutor }` 之外的默认导入习惯
};
