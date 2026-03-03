// 数据库适配器接口
export interface DatabaseAdapter {
    exec(sql: string): Promise<void> | void;
    prepare(sql: string): StatementAdapter;
}

export interface StatementAdapter {
    all(): Promise<{ results: any }> | any[];
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
            throw new Error("D1Adapter: DB not initialized");
        }
        await this.db.exec(sql);
    }

    prepare(sql: string): StatementAdapter {
        if (!this.db) {
            throw new Error("D1Adapter: DB not initialized");
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
