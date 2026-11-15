import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cacheService from "../../../src/service/cacheService";

/**
 * 进程内缓存（P0-3 配套）：Node 常驻模式（桌面端）下原先裸 Map 无上限、无 TTL，
 * 键只增不减。现在加 LRU 容量上限 + 可选 TTL + 惰性清扫，本文件把这些行为钉死。
 *
 * 注意：`configure()` 会改模块级状态，每个用例后必须复位，否则会污染同进程的其他用例。
 */
describe("cacheService", () => {
    beforeEach(() => {
        cacheService.clear();
        cacheService.configure({ maxSize: 1_000, now: () => Date.now() });
    });

    afterEach(() => {
        cacheService.clear();
        cacheService.configure({ maxSize: 1_000, now: () => Date.now() });
    });

    it("stores and retrieves values by key", () => {
        cacheService.set("k1", { value: 42 });

        expect(cacheService.get<{ value: number }>("k1")).toEqual({ value: 42 });
        expect(cacheService.get("missing")).toBeNull();
        expect(cacheService.has("k1")).toBe(true);
        expect(cacheService.has("missing")).toBe(false);
    });

    it("deletes values by key", () => {
        cacheService.set("k1", 1);

        expect(cacheService.del("k1")).toBe(true);
        expect(cacheService.has("k1")).toBe(false);
        expect(cacheService.del("k1")).toBe(false);
    });

    it("lists all entries and clears the store", () => {
        cacheService.set("a", 1);
        cacheService.set("b", 2);

        expect(cacheService.entries()).toEqual([
            ["a", 1],
            ["b", 2],
        ]);

        cacheService.clear();
        expect(cacheService.entries()).toEqual([]);
    });

    describe("LRU / maxSize 容量上限", () => {
        it("超出容量时淘汰最久未使用的键", () => {
            cacheService.configure({ maxSize: 2 });

            cacheService.set("a", 1);
            cacheService.set("b", 2);
            cacheService.set("c", 3);

            expect(cacheService.size()).toBe(2);
            expect(cacheService.get("a")).toBeNull(); // 最早写入且未被访问过 → 被淘汰
            expect(cacheService.get("b")).toBe(2);
            expect(cacheService.get("c")).toBe(3);
        });

        it("命中会把键移到队尾，从而保护它不被淘汰", () => {
            cacheService.configure({ maxSize: 2 });

            cacheService.set("a", 1);
            cacheService.set("b", 2);
            // 访问 a：a 变成最近使用，b 变成最久未使用
            expect(cacheService.get("a")).toBe(1);
            cacheService.set("c", 3);

            expect(cacheService.get("b")).toBeNull();
            expect(cacheService.get("a")).toBe(1);
            expect(cacheService.get("c")).toBe(3);
        });

        it("覆盖写同一个键不会挤掉别的键", () => {
            cacheService.configure({ maxSize: 2 });

            cacheService.set("a", 1);
            cacheService.set("b", 2);
            cacheService.set("a", 10);

            expect(cacheService.size()).toBe(2);
            expect(cacheService.get("a")).toBe(10);
            expect(cacheService.get("b")).toBe(2);
        });

        it("调小 maxSize 会立即按 LRU 收缩", () => {
            cacheService.set("a", 1);
            cacheService.set("b", 2);
            cacheService.set("c", 3);
            expect(cacheService.size()).toBe(3);

            cacheService.configure({ maxSize: 1 });

            expect(cacheService.size()).toBe(1);
            expect(cacheService.get("c")).toBe(3); // 最近写入的留下
            expect(cacheService.get("a")).toBeNull();
            expect(cacheService.get("b")).toBeNull();
        });

        it("容量下界是 1（传 0 或负数不会把缓存关掉）", () => {
            cacheService.configure({ maxSize: 0 });
            cacheService.set("a", 1);
            cacheService.set("b", 2);

            expect(cacheService.size()).toBe(1);
            expect(cacheService.get("b")).toBe(2);
        });
    });

    describe("TTL 过期与清扫", () => {
        let clock = 0;
        beforeEach(() => {
            clock = 1_700_000_000_000;
            cacheService.configure({ now: () => clock });
        });

        it("未设 TTL 的键不会过期", () => {
            cacheService.set("forever", 1);
            clock += 365 * 24 * 3600 * 1000;

            expect(cacheService.get("forever")).toBe(1);
            expect(cacheService.has("forever")).toBe(true);
        });

        it("超过 TTL 后 get / has / entries 都看不到该键", () => {
            cacheService.set("tmp", 1, 1_000);
            cacheService.set("keep", 2);

            clock += 999;
            expect(cacheService.get("tmp")).toBe(1);

            clock += 2; // 越过 TTL
            expect(cacheService.get("tmp")).toBeNull();
            expect(cacheService.has("tmp")).toBe(false);
            expect(cacheService.entries()).toEqual([["keep", 2]]);
        });

        it("过期键在下一次 get 时被真正删除（不只是读到 null）", () => {
            cacheService.set("tmp", 1, 100);
            clock += 200;

            expect(cacheService.size()).toBe(1); // 惰性清理：此时还没删
            expect(cacheService.get("tmp")).toBeNull();
            expect(cacheService.size()).toBe(0); // get 时已删除
        });

        it("pruneExpired 批量清理并返回清理数量", () => {
            cacheService.set("a", 1, 100);
            cacheService.set("b", 2, 200);
            cacheService.set("c", 3);

            clock += 150;
            expect(cacheService.pruneExpired()).toBe(1); // a 过期
            clock += 100;
            expect(cacheService.pruneExpired()).toBe(1); // b 过期
            expect(cacheService.pruneExpired()).toBe(0);

            expect(cacheService.get("c")).toBe(3);
            expect(cacheService.size()).toBe(1);
        });

        it("重新 set 同一键会刷新 TTL", () => {
            cacheService.set("k", 1, 100);
            clock += 80;
            cacheService.set("k", 2, 100); // 重新计时

            clock += 80; // 距首次写入 160ms，但距刷新只有 80ms
            expect(cacheService.get("k")).toBe(2);

            clock += 30; // 距刷新 110ms > 100ms
            expect(cacheService.get("k")).toBeNull();
        });
    });
});
