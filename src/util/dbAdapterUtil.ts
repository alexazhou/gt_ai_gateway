import customError from "./customErrorUtil";

// 数据库适配器接口
export interface DatabaseAdapter {
    exec(sql: string): Promise<void> | void;
    prepare(sql: string): StatementAdapter;
}

export interface StatementAdapter {
    all(): Promise<any> | any;
    first(): Promise<any> | any;
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
}

class SQLiteStatementAdapter implements StatementAdapter {
    constructor(private stmt: any) {}

    all(): any[] {
        return this.stmt.all();
    }

    first(): any {
        return this.stmt.get();
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

    setDB(db: D1Database) {
        this.db = db;
    }
}

class D1StatementAdapter implements StatementAdapter {
    constructor(private stmt: any) {}

    async all(): Promise<{ results: any }> {
        return await this.stmt.all();
    }

    async first(): Promise<any> {
        return await this.stmt.first();
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

    private _pool(): any {
        if (this.pool) return this.pool;
        if (this.fallback) return this.fallback();
        throw new customError.AppError("MySQLAdapter: pool not initialized", 500);
    }
}

class MySQLStatementAdapter implements StatementAdapter {
    constructor(private pool: any, private sql: string) {}

    async all(): Promise<any[]> {
        const [rows] = await this.pool.query(this.sql);
        return rows as any[];
    }

    async first(): Promise<any> {
        const [rows] = await this.pool.query(this.sql);
        return (rows as any[])[0];
    }

    async run(...args: any[]): Promise<any> {
        const [result] = await this.pool.execute(this.sql, args);
        return result;
    }
}
