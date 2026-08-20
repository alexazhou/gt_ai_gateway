import { join } from "path";
import { existsSync, readdirSync } from "fs";

// 统一的执行 SQL 接口（迁移侧）
// 允许异步（MySQL 适配器），同步适配器（SQLite）返回普通值，await 同样生效
export interface DBAdapter {
    exec(sql: string): Promise<void> | void;
    query<T>(sql: string): Promise<T[]> | T[];
    run(sql: string, ...params: any[]): Promise<void> | void;
    close(): Promise<void> | void;
    execTransaction?(sqls: string[]): Promise<void> | void;
}

// 迁移目录，默认 resource/migrate，可通过环境变量覆盖
export const MIGRATION_DIR =
    process.env.MIGRATION_DIR ||
    join(process.cwd(), "resource", "migrate");

export const MIGRATION_START_MARKER = "[GT_AI_GATEWAY_MIGRATION_START]";
export const MIGRATION_END_MARKER = "[GT_AI_GATEWAY_MIGRATION_END]";

export type Dialect = "sqlite" | "mysql";

// 当前方言：worker 走 D1（sqlite 方言）；node / test 由 DB_DRIVER 决定（默认 sqlite）
export function getDialect(env: string): Dialect {
    if (env === "worker-local" || env === "worker-cloud") {
        return "sqlite";
    }
    return process.env.DB_DRIVER === "mysql" ? "mysql" : "sqlite";
}

// 一个迁移目录下、当前方言应执行的文件（方言文件优先，无则回退 common.sql）
export function migrationSqlFile(dir: string, dialect: Dialect): string {
    const candidates =
        dialect === "mysql" ? ["mysql.sql", "common.sql"] : ["sqlite.sql", "common.sql"];
    for (const f of candidates) {
        const p = join(dir, f);
        if (existsSync(p)) return p;
    }
    throw new Error(`Migration ${dir} has no SQL file for dialect ${dialect}`);
}

// 列出所有迁移目录（按名字排序，如 migrate_0001 … migrate_0028）
export function listMigrations(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^migrate_\d{4}$/.test(d.name))
        .map((d) => d.name)
        .sort();
}

// _migrations 记录表 DDL（按方言）
export function migrationsTableDdl(dialect: Dialect): string {
    return dialect === "mysql"
        ? "CREATE TABLE IF NOT EXISTS _migrations (id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
        : "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";
}
