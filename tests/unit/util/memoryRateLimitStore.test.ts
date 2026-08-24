import { beforeEach, describe, expect, it } from "vitest";
import memoryRateLimitStore from "../../../src/util/rule/memoryRateLimitStore";

const WINDOW = 60_000;
const BASE = 1_700_000_040_000;

// 便捷封装：容量 = rpm、补液 = rpm/WINDOW
function consume(key: string, now: number, rpm: number) {
    return memoryRateLimitStore.consume(key, now, rpm, rpm / WINDOW);
}

describe("memoryRateLimitStore", () => {
    beforeEach(() => {
        memoryRateLimitStore.clear();
    });

    it("starts full at capacity and consumes one token per call", () => {
        // 容量 3 的桶：前 3 次放行，剩余依次 2/1/0
        expect(consume("r1", BASE, 3)).toEqual({ allowed: true, remaining: 2 });
        expect(consume("r1", BASE, 3)).toEqual({ allowed: true, remaining: 1 });
        expect(consume("r1", BASE, 3)).toEqual({ allowed: true, remaining: 0 });
        // 第 4 次：桶空被限流，remaining 停在 0（同一时刻无补液）
        expect(consume("r1", BASE, 3)).toEqual({ allowed: false, remaining: 0 });
    });

    it("keeps buckets independent per key", () => {
        expect(consume("a", BASE, 1)).toEqual({ allowed: true, remaining: 0 });
        // b 是独立的满桶（容量 2）
        expect(consume("b", BASE, 2)).toEqual({ allowed: true, remaining: 1 });
    });

    it("refills tokens over time at refillPerMs rate", () => {
        // 容量 1 空桶：30s 后补 0.5 个令牌，仍不够 1 → 限流
        consume("r1", BASE, 1);
        const mid = BASE + 30_000;
        expect(consume("r1", mid, 1)).toEqual({ allowed: false, remaining: 0.5 });
        // 再 30s 补满 1 个令牌 → 放行，扣减后剩余 0
        const full = BASE + WINDOW;
        expect(consume("r1", full, 1)).toEqual({ allowed: true, remaining: 0 });
    });

    it("caps tokens at capacity (no overflow after long idle)", () => {
        // 容量 2 的桶消耗 1 个令牌 → 剩 1
        consume("r1", BASE, 2);
        // 闲 10 分钟：补液远超容量，封顶回满 2，再扣 1 → 剩 1
        const far = BASE + 10 * WINDOW;
        const result = consume("r1", far, 2);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBeCloseTo(1, 10);
    });

    it("cleanup removes keys idle beyond limit", () => {
        consume("stale", BASE, 1);
        consume("fresh", BASE, 1);
        // fresh 在下一分钟仍活跃
        consume("fresh", BASE + WINDOW, 1);
        // 清扫：stale 空闲满 2 分钟 → 回收；fresh 最近活跃 → 保留
        memoryRateLimitStore.cleanup(BASE + 2 * WINDOW);
        expect(memoryRateLimitStore.size()).toBe(1);
        // fresh 保留且桶仍可用
        expect(consume("fresh", BASE + 2 * WINDOW, 1)).toEqual({ allowed: true, remaining: 0 });
    });

    it("recreates from full capacity after stale key cleanup", () => {
        consume("stale", BASE, 1);
        memoryRateLimitStore.cleanup(BASE + 2 * WINDOW);
        // 重建后从满桶开始：容量 1 的第一个请求放行
        expect(consume("stale", BASE + 2 * WINDOW, 1)).toEqual({ allowed: true, remaining: 0 });
    });
});