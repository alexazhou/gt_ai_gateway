import { DBAdapter } from "./dbAdapter";

// MySQL 连接配置（离散变量或 DB_URL）
export interface MySQLConnOptions {
    uri?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
}

export class MySQLDBAdapter implements DBAdapter {
    private conn: MySQLConnOptions;
    private poolPromise: Promise<any> | null = null;

    constructor(conn: MySQLConnOptions) {
        // P2-17：原来在构造函数里 `require("mysql2/promise")` —— ESM 环境下 require 不存在，
        // 且静态 require 会让 worker 打包尝试把 mysql2（依赖 node 内置模块）打进 bundle。
        // 改成懒加载 + `await import()`：构造函数保持同步（调用方多为同步工厂），
        // 首次真正执行语句时才加载驱动；worker 模式永远不会走到这里。
        this.conn = conn;
    }

    /**
     * 懒加载连接池：mysql2/promise 的 createPool 同步返回连接池，这里用 Promise 缓存避免并发首用重复建池。
     */
    private pool(): Promise<any> {
        if (!this.poolPromise) {
            this.poolPromise = (async () => {
                const imported = await import("mysql2/promise");
                // CJS interop：不同打包器下 default 可能是模块本身，也可能挂在 default 上
                const mysql: any = (imported as any).default ?? imported;
                // multipleStatements: true —— 迁移文件常含多条语句，交由 exec 一次执行
                return mysql.createPool({
                    uri: this.conn.uri,
                    host: this.conn.host,
                    port: this.conn.port,
                    user: this.conn.user,
                    password: this.conn.password,
                    database: this.conn.database,
                    connectionLimit: 10,
                    multipleStatements: true,
                    charset: "utf8mb4",
                    dateStrings: true,
                });
            })();
        }
        return this.poolPromise;
    }

    private async withConn<T>(fn: (c: any) => Promise<T>): Promise<T> {
        const pool = await this.pool();
        const c = await pool.getConnection();
        try {
            return await fn(c);
        } finally {
            c.release();
        }
    }

    async exec(sql: string): Promise<void> {
        await this.withConn(async (c) => c.query(sql));
    }

    async query<T>(sql: string): Promise<T[]> {
        return this.withConn(async (c) => {
            const [rows] = await c.query(sql);
            return rows as T[];
        });
    }

    async run(sql: string, ...params: any[]): Promise<void> {
        await this.withConn(async (c) => c.execute(sql, params));
    }

    async execTransaction(sqls: string[]): Promise<void> {
        await this.withConn(async (c) => {
            try {
                await c.beginTransaction();
                for (const s of sqls) {
                    await c.query(s);
                }
                await c.commit();
            } catch (e) {
                await c.rollback();
                throw e;
            }
        });
    }

    async close(): Promise<void> {
        if (!this.poolPromise) {
            // 从未使用过：没有池可关
            return;
        }
        const pool = await this.poolPromise;
        await pool.end();
        this.poolPromise = null;
    }
}
