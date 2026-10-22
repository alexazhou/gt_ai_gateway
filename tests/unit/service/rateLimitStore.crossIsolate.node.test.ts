import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqlRateLimitStore } from "../../../src/util/rule/sqlRateLimitStore";
import type { SqlExecutor } from "../../../src/util/rule/sqlExecutor";

/**
 * P0-2 回归：「限流在 Worker 下失效」的跨 isolate 语义。
 *
 * 问题现场：令牌桶原先是 isolate 内 Map，实际 rpm ≈ 配置 × isolate 数，
 * 规则可成倍绕过。修复后桶状态落 D1（`rate_limit_bucket`），跨 isolate 共享。
 *
 * 这里用「同一份 SQLite 文件的多个连接」模拟「多个 isolate 连同一个 D1」：
 * 每个连接 = 一个 isolate 的数据库会话。断言的核心不变量是
 * **同一逻辑时刻、不论从哪个 isolate 发起，放行总数都等于 rpm，不翻倍**。
 */

const MIGRATION_SQL = readFileSync(
    resolve(process.cwd(), "resource/migrate/migrate_0033/sqlite.sql"),
    "utf-8",
);

const T0 = 1_700_000_000_000;

function executorFor(db: Database.Database): SqlExecutor {
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

/** rpm → 令牌桶参数（与 rateLimitService.tokenBucketParams 同口径：容量 = rpm，60s 补满） */
function bucketParams(rpm: number): { capacity: number; refillPerMs: number } {
    return { capacity: rpm, refillPerMs: rpm / 60_000 };
}

describe("限流跨 isolate（P0-2 回归）", () => {
    let dir: string;
    let connections: Database.Database[];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-ratelimit-cross-"));
        connections = [];
    });

    afterEach(() => {
        for (const db of connections) {
            try {
                db.close();
            } catch (e) {
                // 已关闭，忽略
            }
        }
        rmSync(dir, { recursive: true, force: true });
    });

    /** 打开共享同一个 D1 文件的两个"isolate"（各自独立连接） */
    function openIsolates(): [SqlRateLimitStore, SqlRateLimitStore] {
        const file = join(dir, "d1-shared.db");
        const dbA = new Database(file);
        dbA.exec(MIGRATION_SQL);
        const dbB = new Database(file);
        connections.push(dbA, dbB);
        return [
            new SqlRateLimitStore(executorFor(dbA)),
            new SqlRateLimitStore(executorFor(dbB)),
        ];
    }

    /** 打开两个互不共享的库（= 修复前"每个 isolate 一份内存"的等价语义） */
    function openIsolatedStores(): [SqlRateLimitStore, SqlRateLimitStore] {
        const dbA = new Database(":memory:");
        dbA.exec(MIGRATION_SQL);
        const dbB = new Database(":memory:");
        dbB.exec(MIGRATION_SQL);
        connections.push(dbA, dbB);
        return [
            new SqlRateLimitStore(executorFor(dbA)),
            new SqlRateLimitStore(executorFor(dbB)),
        ];
    }

    it("两个 isolate 连同一份 D1：放行总数等于 rpm，不翻倍", async () => {
        const [isolateA, isolateB] = openIsolates();
        const { capacity, refillPerMs } = bucketParams(3);
        const key = "rule:42:rpm";

        // isolate A 先把额度打满
        for (let i = 0; i < 3; i++) {
            const result = await isolateA.consume(key, T0, capacity, refillPerMs);
            expect(result.allowed).toBe(true);
        }

        // isolate B 在同一逻辑时刻必须看到「桶已空」——这是修复前做不到的
        for (let i = 0; i < 3; i++) {
            const result = await isolateB.consume(key, T0, capacity, refillPerMs);
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBeLessThan(1);
        }

        // 反转方向再验一次：B 重置后 A 也看得到
        const [freshA, freshB] = openIsolates();
        const key2 = "rule:43:rpm";
        for (let i = 0; i < 3; i++) {
            expect((await freshB.consume(key2, T0, capacity, refillPerMs)).allowed).toBe(true);
        }
        expect((await freshA.consume(key2, T0, capacity, refillPerMs)).allowed).toBe(false);
    });

    it("对照：状态不共享时额度会翻倍（修复前的失效形态）", async () => {
        const [storeA, storeB] = openIsolatedStores();
        const { capacity, refillPerMs } = bucketParams(3);
        const key = "rule:42:rpm";

        let allowed = 0;
        for (const store of [storeA, storeB]) {
            for (let i = 0; i < 3; i++) {
                if ((await store.consume(key, T0, capacity, refillPerMs)).allowed) {
                    allowed++;
                }
            }
        }

        // 每个 isolate 各拿到一份全额额度：总计 2 × rpm，正是 P0-2 的现场
        expect(allowed).toBe(6);
    });

    it("两个 isolate 交替并发扣减：放行数恰好等于容量，令牌不会被扣成负数", async () => {
        const [isolateA, isolateB] = openIsolates();
        const { capacity, refillPerMs } = bucketParams(3);
        const key = "rule:7:rpm";

        const results = await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
                (i % 2 === 0 ? isolateA : isolateB).consume(key, T0, capacity, refillPerMs),
            ),
        );

        expect(results.filter((r) => r.allowed)).toHaveLength(3);

        const db = connections[0];
        const row = db.prepare("SELECT tokens FROM rate_limit_bucket WHERE bucket_key = ?").get(key) as
            | { tokens: number }
            | undefined;
        expect(row).toBeDefined();
        expect(row!.tokens).toBeGreaterThanOrEqual(0);
        expect(row!.tokens).toBeLessThan(1);
    });

    it("被拒绝的请求不扣减令牌（不会越拒绝越负）", async () => {
        const [isolateA, isolateB] = openIsolates();
        const { capacity, refillPerMs } = bucketParams(1);
        const key = "rule:1:rpm";

        expect((await isolateA.consume(key, T0, capacity, refillPerMs)).allowed).toBe(true);

        for (let i = 0; i < 5; i++) {
            expect((await isolateB.consume(key, T0, capacity, refillPerMs)).allowed).toBe(false);
        }

        const row = connections[0]
            .prepare("SELECT tokens FROM rate_limit_bucket WHERE bucket_key = ?")
            .get(key) as { tokens: number };
        expect(row.tokens).toBe(0);
    });

    it("不同规则的桶在两个 isolate 上互相独立", async () => {
        const [isolateA, isolateB] = openIsolates();
        const { capacity, refillPerMs } = bucketParams(1);

        expect((await isolateA.consume("rule:1:rpm", T0, capacity, refillPerMs)).allowed).toBe(true);
        // 同一个键在另一个 isolate 上已限流
        expect((await isolateB.consume("rule:1:rpm", T0, capacity, refillPerMs)).allowed).toBe(false);
        // 另一个规则不受影响
        expect((await isolateB.consume("rule:2:rpm", T0, capacity, refillPerMs)).allowed).toBe(true);
    });

    it("按时间补液后，两个 isolate 看到同一份剩余量", async () => {
        const [isolateA, isolateB] = openIsolates();
        const { capacity, refillPerMs } = bucketParams(2); // 30s 补 1 个
        const key = "rule:5:rpm";

        await isolateA.consume(key, T0, capacity, refillPerMs);
        await isolateA.consume(key, T0, capacity, refillPerMs);
        expect((await isolateB.consume(key, T0, capacity, refillPerMs)).allowed).toBe(false);

        // 30s 后补满 1 个：不论从哪个 isolate 扣，都只放行一次
        const afterRefill = await isolateB.consume(key, T0 + 30_000, capacity, refillPerMs);
        expect(afterRefill.allowed).toBe(true);
        const secondTry = await isolateA.consume(key, T0 + 30_000, capacity, refillPerMs);
        expect(secondTry.allowed).toBe(false);
    });
});
