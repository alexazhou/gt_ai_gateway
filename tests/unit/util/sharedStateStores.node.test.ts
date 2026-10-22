import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqlRateLimitStore } from "../../../src/util/rule/sqlRateLimitStore";
import { SqlUpstreamHealthStore } from "../../../src/util/health/sqlHealthStore";
import type { SqlExecutor } from "../../../src/util/rule/sqlExecutor";

/**
 * P0-2 / P0-3 回归：共享存储层的 SQL 语义（node / better-sqlite3 真库）。
 *
 * 这两张表只在 Worker(D1) 路径被读写，但 D1 与 better-sqlite3 同源（SQLite），
 * 因此这里用真库把方言细节（ON CONFLICT / 标量 MIN、MAX / RETURNING）先钉死：
 * - 限流扣减必须是**单条带条件的 UPDATE**，并发下不能超发；
 * - 冷却标记必须是 upsert，写入失败不影响本地冷却（后者在 service 层用例覆盖）。
 */

const MIGRATION_SQL = readFileSync(
    resolve(process.cwd(), "resource/migrate/migrate_0033/sqlite.sql"),
    "utf-8",
);

function createExecutor(db: Database.Database): SqlExecutor {
    return {
        async run(sql: string, params: unknown[] = []) {
            const result = db.prepare(sql).run(...(params as never[]));
            return { changes: result.changes };
        },
        async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            return db.prepare(sql).all(...(params as never[])) as T[];
        },
    };
}

describe("SqlRateLimitStore（better-sqlite3 真库）", () => {
    let db: Database.Database;
    let store: SqlRateLimitStore;
    const T0 = 1_700_000_000_000;

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(MIGRATION_SQL);
        store = new SqlRateLimitStore(createExecutor(db));
    });

    afterEach(() => {
        db.close();
    });

    it("allows exactly `capacity` requests then rejects", async () => {
        // rpm = 2 → 容量 2，补液速率 2 每分钟
        const refillPerMs = 2 / 60_000;

        await expect(store.consume("bucket", T0, 2, refillPerMs)).resolves.toEqual({
            allowed: true,
            remaining: 1,
        });
        await expect(store.consume("bucket", T0, 2, refillPerMs)).resolves.toEqual({
            allowed: true,
            remaining: 0,
        });

        const denied = await store.consume("bucket", T0, 2, refillPerMs);
        expect(denied.allowed).toBe(false);
        expect(denied.remaining).toBeLessThan(1);
    });

    it("refills tokens proportionally to elapsed time", async () => {
        const refillPerMs = 2 / 60_000; // 30s 补 1 个令牌

        await store.consume("bucket", T0, 2, refillPerMs);
        await store.consume("bucket", T0, 2, refillPerMs);
        expect((await store.consume("bucket", T0, 2, refillPerMs)).allowed).toBe(false);

        // 未补满 1 个令牌前仍拒绝
        expect((await store.consume("bucket", T0 + 29_000, 2, refillPerMs)).allowed).toBe(false);
        // 补满 1 个后可放行一次
        await expect(store.consume("bucket", T0 + 30_000, 2, refillPerMs)).resolves.toEqual({
            allowed: true,
            remaining: 0,
        });
    });

    it("does not over-issue under concurrent consumes", async () => {
        const refillPerMs = 3 / 60_000;
        const results = await Promise.all(
            Array.from({ length: 10 }, () => store.consume("bucket", T0, 3, refillPerMs)),
        );

        expect(results.filter((r) => r.allowed)).toHaveLength(3);
        const row = db.prepare("SELECT tokens FROM rate_limit_bucket WHERE bucket_key = ?").get("bucket") as {
            tokens: number;
        };
        expect(row.tokens).toBeGreaterThanOrEqual(0);
        expect(row.tokens).toBeLessThan(1);
    });

    it("never reports remaining above capacity", async () => {
        const refillPerMs = 2 / 60_000;
        await store.consume("bucket", T0, 2, refillPerMs);
        await store.consume("bucket", T0, 2, refillPerMs);

        // 很久之后：补液被 MIN(capacity, ...) 截断，剩余量不会超过容量
        const result = await store.consume("bucket", T0 + 3_600_000, 2, refillPerMs);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBeLessThanOrEqual(2);
    });

    it("keeps buckets isolated per key", async () => {
        const refillPerMs = 1 / 60_000;
        await store.consume("rule-1", T0, 1, refillPerMs);

        expect((await store.consume("rule-1", T0, 1, refillPerMs)).allowed).toBe(false);
        expect((await store.consume("rule-2", T0, 1, refillPerMs)).allowed).toBe(true);
    });
});

describe("SqlUpstreamHealthStore（better-sqlite3 真库）", () => {
    let db: Database.Database;
    let store: SqlUpstreamHealthStore;
    const KEY = "upstream-health:3:claude-sonnet:openai";

    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(MIGRATION_SQL);
        store = new SqlUpstreamHealthStore(createExecutor(db));
    });

    afterEach(() => {
        db.close();
    });

    it("upserts the failure time for the same key", async () => {
        await store.markFailure(KEY, 1_000);
        await store.markFailure(KEY, 2_000);

        await expect(store.listFailuresSince(0)).resolves.toEqual([{ key: KEY, failedAt: 2_000 }]);
    });

    it("filters by failedAt >= since", async () => {
        await store.markFailure(KEY, 1_000);
        await store.markFailure("upstream-health:8:gpt:openai", 5_000);

        const rows = await store.listFailuresSince(2_000);
        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe("upstream-health:8:gpt:openai");
    });

    it("prunes expired rows and clears all", async () => {
        await store.markFailure(KEY, 1_000);
        await store.markFailure("upstream-health:8:gpt:openai", 5_000);

        await store.prune(3_000);
        await expect(store.listFailuresSince(0)).resolves.toEqual([
            { key: "upstream-health:8:gpt:openai", failedAt: 5_000 },
        ]);

        await store.clear();
        await expect(store.listFailuresSince(0)).resolves.toEqual([]);
    });
});
