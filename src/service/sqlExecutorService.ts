import ormService from "./ormService";
import type { SqlExecutor } from "../util/rule/sqlExecutor";

/**
 * 基于 ormService 当前适配器的 SQL 执行器。
 *
 * 注意：Worker 下 D1 binding 是 per-request 的，`ormService.dbAdapter` 每次请求都由
 * dbMiddleware 更新到当前 binding，因此这里必须**每次调用时**取 `ormService.dbAdapter`，
 * 不能在模块加载时缓存适配器实例。
 */
export class OrmSqlExecutor implements SqlExecutor {
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
        const result = await ormService.dbAdapter.prepare(sql).run(...params);
        // D1: { meta: { changes } } / better-sqlite3: { changes } / mysql2: { affectedRows }
        const raw = result as { meta?: { changes?: number }; changes?: number; affectedRows?: number } | undefined;
        const changes = raw?.meta?.changes ?? raw?.changes ?? raw?.affectedRows ?? 0;
        return { changes: Number(changes) || 0 };
    }

    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        const result = await ormService.dbAdapter.prepare(sql).all(...params);
        // D1 返回 { results: [...] }，sqlite / mysql 直接返回数组
        if (Array.isArray(result)) {
            return result as T[];
        }
        const wrapped = result as { results?: unknown } | undefined;
        return Array.isArray(wrapped?.results) ? wrapped.results as T[] : [];
    }
}

export default OrmSqlExecutor;
