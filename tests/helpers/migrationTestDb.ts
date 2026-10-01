import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dbMigrationService from "../../src/service/dbMigrationService";
import { SQLiteDBAdapter } from "../../src/util/db/sqliteDBAdapter";
import { MySQLDBAdapter, type MySQLConnOptions } from "../../src/util/db/mysqlDBAdapter";
import type { DBAdapter } from "../../src/util/db/dbAdapter";

/**
 * 给迁移类用例准备一个「刚建好、一张表都没有」的库，用完销毁。
 *
 * 跟着当前的 DB_DRIVER 走，而不是固定某一种：CI 的 MySQL 任务里验的就是 MySQL。
 * 不复用共享的测试数据库——这些用例的前提是空库，而共享库已经被迁移并灌过数据了。
 */
export interface MigrationTestDb {
    adapter: DBAdapter;
    /** mysql：后端进程要连的库名；sqlite：undefined */
    databaseName?: string;
    /** sqlite：库文件路径；mysql：undefined */
    filePath?: string;
    close(): Promise<void>;
}

function currentDriverIsMysql(): boolean {
    return process.env.DB_DRIVER === "mysql";
}

/**
 * 把连接参数指向指定库（undefined = 不指定，连到 server 上）。
 * DB_URL 形式（mysql://user:pass@host:port/db）改的是 URL 里的库名——否则它会覆盖 database 字段。
 */
function withDatabase(conn: MySQLConnOptions, database: string | undefined): MySQLConnOptions {
    if (!conn.uri) {
        return { ...conn, database };
    }
    const url = new URL(conn.uri);
    url.pathname = database ? `/${database}` : "/";
    return { ...conn, uri: url.toString() };
}

export async function createMigrationTestDb(): Promise<MigrationTestDb> {
    if (currentDriverIsMysql()) {
        const mysql = (await import("mysql2/promise")).default;
        const conn = dbMigrationService.mysqlConnFromEnv();
        const databaseName = `gt_migration_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

        // 不带 database 的连接：建库、删库要连到 server 上，而不是连到某个库里
        const admin = await mysql.createConnection(withDatabase(conn, undefined));
        await admin.query(`CREATE DATABASE \`${databaseName}\``);
        await admin.end();

        const adapter = new MySQLDBAdapter(withDatabase(conn, databaseName));

        return {
            adapter,
            databaseName,
            close: async () => {
                adapter.close();
                const cleanup = await mysql.createConnection(withDatabase(conn, undefined));
                await cleanup.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
                await cleanup.end();
            },
        };
    }

    const dir = mkdtempSync(join(tmpdir(), "gt-migration-test-"));
    const filePath = join(dir, "test.db");
    const adapter = new SQLiteDBAdapter(filePath);

    return {
        adapter,
        filePath,
        close: async () => {
            adapter.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** 列出这个库里的所有表（按当前驱动选查询） */
export async function listTables(adapter: DBAdapter): Promise<string[]> {
    const sql = currentDriverIsMysql()
        ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()"
        : "SELECT name FROM sqlite_master WHERE type='table'";
    const rows = (await adapter.query<{ name: string }>(sql)) as Array<{ name: string }>;
    return rows.map((row) => row.name);
}
