import customError from "../customError";

// 一条待执行的参数化语句（原子批处理用）
export interface SqlStatement {
    sql: string;
    params?: unknown[];
}

// 数据库适配器接口
export interface DatabaseAdapter {
    exec(sql: string): Promise<void> | void;
    prepare(sql: string): StatementAdapter;
    /**
     * 原子执行多条语句：要么全部生效，要么全部回滚。
     * 语义由各驱动实现保证（D1 batch / better-sqlite3 transaction / MySQL 事务），
     * 用于"钱账一致"这类跨表写入（见 billingSettlementService）。
     */
    runAtomically(statements: SqlStatement[]): Promise<void> | void;
}

export interface StatementAdapter {
    // 可选参数用于绑定占位符（D1 / better-sqlite3 / mysql2 均支持）；不传时保持旧行为
    all(...args: any[]): Promise<any> | any;
    first(...args: any[]): Promise<any> | any;
    run(...args: any[]): Promise<any> | any;
}

// SQLite 适配器
export class SQLiteAdapter implements DatabaseAdapter {
    constructor(private db: any) {}

    exec(sql: string): void {
        this.db.exec(sql);
    }

    prepare(sql: string): StatementAdapter {
        const stmt = this.db.prepare(sql);
        return new SQLiteStatementAdapter(stmt);
    }

    // better-sqlite3 的 db.transaction() 同步执行，异常自动回滚
    runAtomically(statements: SqlStatement[]): void {
        const runAll = this.db.transaction((stmts: SqlStatement[]) => {
            for (const stmt of stmts) {
                this.db.prepare(stmt.sql).run(...(stmt.params ?? []));
            }
        });
        runAll(statements);
    }
}

class SQLiteStatementAdapter implements StatementAdapter {
    constructor(private stmt: any) {}

    all(...args: any[]): any[] {
        return this.stmt.all(...args);
    }

    first(...args: any[]): any {
        return this.stmt.get(...args);
    }

    run(...args: any[]): any {
        return this.stmt.run(...args);
    }
}

// D1 适配器
export class D1Adapter implements DatabaseAdapter {
    constructor(private db?: D1Database) {}

    async exec(sql: string): Promise<void> {
        if (!this.db) {
            throw new customError.AppError("D1Adapter: DB not initialized", 500);
        }
        await this.db.exec(sql);
    }

    prepare(sql: string): StatementAdapter {
        if (!this.db) {
            throw new customError.AppError("D1Adapter: DB not initialized", 500);
        }
        const stmt = this.db.prepare(sql);
        return new D1StatementAdapter(stmt);
    }

    // D1 batch 在同一事务内顺序执行，任一语句失败整批回滚
    async runAtomically(statements: SqlStatement[]): Promise<void> {
        if (!this.db) {
            throw new customError.AppError("D1Adapter: DB not initialized", 500);
        }
        const prepared = statements.map((stmt) => this.db!.prepare(stmt.sql).bind(...(stmt.params ?? [])));
        await this.db.batch(prepared);
    }

    setDB(db: D1Database) {
        this.db = db;
    }
}

class D1StatementAdapter implements StatementAdapter {
    constructor(private stmt: any) {}

    async all(...args: any[]): Promise<{ results: any }> {
        const stmt = args.length > 0 ? this.stmt.bind(...args) : this.stmt;
        return await stmt.all();
    }

    async first(...args: any[]): Promise<any> {
        const stmt = args.length > 0 ? this.stmt.bind(...args) : this.stmt;
        return await stmt.first();
    }

    async run(...args: any[]): Promise<any> {
        return await this.stmt.bind(...args).run();
    }
}

// MySQL 适配器（运行时 DatabaseAdapter）
// 底层使用 mysql2/promise 连接池；prepare 返回的 statement 异步执行
export class MySQLAdapter implements DatabaseAdapter {
    private pool: any;

    constructor(pool?: any, private fallback?: () => any) {
        this.pool = pool;
    }

    // 提供给调用方通过 (ormService.dbAdapter as any).db 访问
    get db(): any {
        return this.pool;
    }

    async exec(sql: string): Promise<void> {
        await this._pool().query(sql);
    }

    prepare(sql: string): StatementAdapter {
        return new MySQLStatementAdapter(this._pool(), sql);
    }

    // 显式事务：多语句要么全部提交，要么整体回滚
    async runAtomically(statements: SqlStatement[]): Promise<void> {
        const pool = this._pool();
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const stmt of statements) {
                await conn.execute(stmt.sql, stmt.params ?? []);
            }
            await conn.commit();
        } catch (e) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error("[MySQLAdapter] rollback failed:", rollbackError);
            }
            throw e;
        } finally {
            conn.release();
        }
    }

    private _pool(): any {
        if (this.pool) return this.pool;
        if (this.fallback) return this.fallback();
        throw new customError.AppError("MySQLAdapter: pool not initialized", 500);
    }
}

class MySQLStatementAdapter implements StatementAdapter {
    constructor(private pool: any, private sql: string) {}

    async all(...args: any[]): Promise<any[]> {
        if (args.length === 0) {
            const [rows] = await this.pool.query(this.sql);
            return rows as any[];
        }
        const [rows] = await this.pool.execute(this.sql, args);
        return rows as any[];
    }

    async first(...args: any[]): Promise<any> {
        const rows = await this.all(...args);
        return rows[0];
    }

    async run(...args: any[]): Promise<any> {
        const [result] = await this.pool.execute(this.sql, args);
        return result;
    }
}
