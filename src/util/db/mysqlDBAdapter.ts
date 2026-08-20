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
    private pool: any;

    constructor(conn: MySQLConnOptions) {
        // mysql2/promise 的 createPool 同步返回连接池，各方法异步执行
        // multipleStatements: true —— 迁移文件常含多条语句，交由 exec 一次执行
        const mysql = require("mysql2/promise");
        this.pool = mysql.createPool({
            uri: conn.uri,
            host: conn.host,
            port: conn.port,
            user: conn.user,
            password: conn.password,
            database: conn.database,
            connectionLimit: 10,
            multipleStatements: true,
            charset: "utf8mb4",
            dateStrings: true,
        });
    }

    private async withConn<T>(fn: (c: any) => Promise<T>): Promise<T> {
        const c = await this.pool.getConnection();
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
        await this.pool.end();
    }
}
