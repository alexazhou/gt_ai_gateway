import Database from "better-sqlite3";
import { DBAdapter } from "./dbAdapter";

export class SQLiteDBAdapter implements DBAdapter {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
    }

    exec(sql: string): void {
        // 直接交给 better-sqlite3 的 exec：它原生支持多语句（内部用 sqlite3_exec）。
        // 原实现先按 `;` 手工 split 再逐条执行，作为「失败回退」——但 `;` 也会出现在字符串字面量、
        // 触发器 BEGIN...END 体内，split 出来的片段本身就不是合法语句，回退路径只会二次报错并且掩盖真实错误。
        this.db.exec(sql);
    }


    execTransaction(sqls: string[]): void {
        const run = this.db.transaction(() => {
            for (const sql of sqls) {
                this.db.exec(sql);
            }
        });
        run();
    }

    query<T>(sql: string): T[] {
        return this.db.prepare(sql).all() as T[];
    }

    run(sql: string, ...params: any[]): void {
        this.db.prepare(sql).run(...params);
    }

    close(): void {
        this.db.close();
    }
}
