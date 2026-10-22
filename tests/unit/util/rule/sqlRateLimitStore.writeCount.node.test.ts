import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqlRateLimitStore } from "../../../../src/util/rule/sqlRateLimitStore";
import type { SqlExecutor } from "../../../../src/util/rule/sqlExecutor";

/**
 * P2-25 验收门：`SqlRateLimitStore.consume()` 的写放大。
 *
 * 现状（修复前）：每次放行都是「INSERT ... ON CONFLICT DO NOTHING（除首个请求外**必然冲突**
 * 的无用写）→ UPDATE 扣减」，D1 上等于每个放行请求 2 次写 + 概率清扫。
 * 目标（修复后）：放行快路径只允许 **1 条写**（UPDATE）；只有「桶不存在」时才 INSERT 一次；
 * 令牌不足时不应产生任何多余写。
 *
 * 断言口径用「语句分类计数」而不是耗时：真库跑得再快，写次数是可数的硬指标。
 * 这里用 better-sqlite3 真库（与 D1 同源 SQLite 方言）+ 计数包装器，SQL 语义和写次数一起验。
 */

const MIGRATION_SQL = readFileSync(
    resolve(process.cwd(), "resource/migrate/migrate_0033/sqlite.sql"),
    "utf-8",
);

interface StatementLog {
    sql: string;
    kind: "insert" | "update" | "select" | "delete";
}

function classify(sql: string): StatementLog["kind"] {
    const head = sql.trimStart().slice(0, 12).toUpperCase();
    if (head.startsWith("INSERT")) return "insert";
    if (head.startsWith("UPDATE")) return "update";
    if (head.startsWith("DELETE")) return "delete";
    return "select";
}

function createCountingExecutor(db: Database.Database, log: StatementLog[]): SqlExecutor {
    return {
        async run(sql: string, params: unknown[] = []) {
            log.push({ sql, kind: classify(sql) });
            const result = db.prepare(sql).run(...(params as never[]));
            return { changes: result.changes };
        },
        async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            log.push({ sql, kind: classify(sql) });
            return db.prepare(sql).all(...(params as never[])) as T[];
        },
    };
}

describe("SqlRateLimitStore 写次数（P2-25）", () => {
    let db: Database.Database;
    let store: SqlRateLimitStore;
    let log: StatementLog[];

    const T0 = 1_700_000_000_000;
    const RPM = 60;
    const REFILL_PER_MS = RPM / 60_000;

    const writes = () => log.filter((s) => s.kind === "insert" || s.kind === "update" || s.kind === "delete");
    const inserts = () => log.filter((s) => s.kind === "insert");

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(MIGRATION_SQL);
        log = [];
        store = new SqlRateLimitStore(createCountingExecutor(db, log));
        // 关掉概率清扫，避免 1% 的 DELETE 打乱计数
        vi.spyOn(Math, "random").mockReturnValue(0.5);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        db.close();
    });

    it("桶已存在时，放行快路径只写 1 次（不再有必然冲突的 INSERT）", async () => {
        // 第一次：桶不存在，允许初始化
        await store.consume("bucket", T0, RPM, REFILL_PER_MS);

        log.length = 0;
        const result = await store.consume("bucket", T0, RPM, REFILL_PER_MS);

        expect(result.allowed).toBe(true);
        expect(inserts(), "桶已存在时不应再 INSERT").toHaveLength(0);
        expect(writes()).toHaveLength(1);
        expect(writes()[0].kind).toBe("update");
    });

    it("连续放行 N 次，写次数 = N（每次一条带条件 UPDATE）", async () => {
        await store.consume("bucket", T0, RPM, REFILL_PER_MS);
        log.length = 0;

        for (let i = 0; i < 5; i++) {
            await store.consume("bucket", T0, RPM, REFILL_PER_MS);
        }

        expect(writes()).toHaveLength(5);
        expect(inserts()).toHaveLength(0);
    });

    it("桶不存在时仍能初始化并放行（缺桶路径不能因为省写而丢掉初始化）", async () => {
        const result = await store.consume("fresh-bucket", T0, RPM, REFILL_PER_MS);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(RPM - 1);
        expect(inserts().length).toBeLessThanOrEqual(1);

        const row = db
            .prepare("SELECT tokens FROM rate_limit_bucket WHERE bucket_key = ?")
            .get("fresh-bucket") as { tokens: number } | undefined;
        expect(row, "初始化后桶必须真的落库（否则等于退回内存实现）").toBeTruthy();
    });

    it("令牌不足时不多写：不 INSERT，只有一条失败的 UPDATE", async () => {
        // rpm=1 → 容量 1，T0 时间点只有 1 个令牌
        const capacity = 1;
        const refill = 1 / 60_000;
        await store.consume("tight", T0, capacity, refill);
        log.length = 0;

        const denied = await store.consume("tight", T0, capacity, refill);

        expect(denied.allowed).toBe(false);
        expect(inserts()).toHaveLength(0);
        expect(writes().length).toBeLessThanOrEqual(1);
    });

    it("降级路径保持正确：桶被删掉后下一个请求能重新初始化", async () => {
        await store.consume("vanishing", T0, RPM, REFILL_PER_MS);
        db.prepare("DELETE FROM rate_limit_bucket WHERE bucket_key = ?").run("vanishing");
        log.length = 0;

        const result = await store.consume("vanishing", T0, RPM, REFILL_PER_MS);

        expect(result.allowed).toBe(true);
        expect(inserts().length).toBe(1);
    });
});
