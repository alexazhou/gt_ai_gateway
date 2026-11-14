import type Database from "better-sqlite3";
import type { SqlExecutor } from "../../src/util/rule/sqlExecutor";

/**
 * better-sqlite3 版的 `SqlExecutor`（D1 同源 SQLite 方言）。
 *
 * 共享存储层（`util/rule/sqlRateLimitStore`、`util/health/sqlHealthStore`）只依赖
 * `SqlExecutor` 这个窄接口，测试里用真库实现它即可，避免各自重复写同一段包装。
 */

export type SqlStatementKind = "insert" | "update" | "select" | "delete";

export interface ExecutedStatement {
    sql: string;
    kind: SqlStatementKind;
}

/** 按语句首词分类，供「写次数」类断言使用（认不出的按 select 计） */
export function classifySql(sql: string): SqlStatementKind {
    const head = sql.trimStart().slice(0, 12).toUpperCase();
    if (head.startsWith("INSERT")) return "insert";
    if (head.startsWith("UPDATE")) return "update";
    if (head.startsWith("DELETE")) return "delete";
    return "select";
}

/**
 * 用 better-sqlite3 数据库连接构造 `SqlExecutor`。
 * 传入 `statements` 时逐条记录语句（sql + 分类），用于写放大/写次数断言。
 */
export function createSqlExecutor(db: Database.Database, statements?: ExecutedStatement[]): SqlExecutor {
    return {
        async run(sql: string, params: unknown[] = []) {
            statements?.push({ sql, kind: classifySql(sql) });
            const result = db.prepare(sql).run(...(params as never[]));
            return { changes: result.changes };
        },
        async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            statements?.push({ sql, kind: classifySql(sql) });
            return db.prepare(sql).all(...(params as never[])) as T[];
        },
    };
}

export default createSqlExecutor;
