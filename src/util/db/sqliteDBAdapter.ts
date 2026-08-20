import Database from "better-sqlite3";
import { DBAdapter } from "./dbAdapter";

export class SQLiteDBAdapter implements DBAdapter {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
    }

    exec(sql: string): void {
        const statements = sql
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        // 对于 sqlite3，多条语句可能导致问题，因此尝试分拆或者使用 .exec() 完整执行
        // better-sqlite3 推荐使用 .exec 执行包含多条语句的完整字符串
        try {
            this.db.exec(sql);
        } catch (e) {
            // 回退分拆单条执行
            for (const statement of statements) {
                if (statement) {
                    this.db.exec(statement + ";");
                }
            }
        }
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
