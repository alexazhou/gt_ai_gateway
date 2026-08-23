import { beforeEach, describe, expect, it } from "vitest";
import memoryRateLimitStore from "../../../src/util/rule/memoryRateLimitStore";

const WINDOW = 60_000;
// 对齐到分钟边界（60000 的整数倍），避免分钟内 elapsed 偏移影响加权断言
const BASE = 1_700_000_040_000;

describe("memoryRateLimitStore", () => {
    beforeEach(() => {
        memoryRateLimitStore.clear();
    });

    it("increments and returns count within the same window", () => {
        expect(memoryRateLimitStore.incr("r1", BASE)).toBe(1);
        expect(memoryRateLimitStore.incr("r1", BASE + 1000)).toBe(2);
    });

    it("keeps keys independent per rule", () => {
        expect(memoryRateLimitStore.incr("a", BASE)).toBe(1);
        expect(memoryRateLimitStore.incr("b", BASE)).toBe(1);
        expect(memoryRateLimitStore.incr("a", BASE)).toBe(2);
    });

    it("rolls current count into previous window at minute boundary", () => {
        // 上一分钟末尾累计 2 次
        memoryRateLimitStore.incr("r1", BASE + 59_000);
        memoryRateLimitStore.incr("r1", BASE + 59_500);
        // 下一分钟起始：prevCount=2、curCount=1、elapsed=0 → 1 + 2 * 1 = 3
        const weighted = memoryRateLimitStore.incr("r1", BASE + WINDOW);
        expect(weighted).toBe(3);
    });

    it("drops stale data when more than one window has elapsed", () => {
        memoryRateLimitStore.incr("r1", BASE);
        const twoWindowsLater = BASE + 2 * WINDOW;
        const weighted = memoryRateLimitStore.incr("r1", twoWindowsLater);
        expect(weighted).toBe(1);
    });

    it("weighted interpolation decays as the previous window ages out", () => {
        // 分钟 M 累计 1 次
        memoryRateLimitStore.incr("r1", BASE);
        // 分钟 M+1 起始：prev=1、cur=1、elapsed=0 → 2
        expect(memoryRateLimitStore.incr("r1", BASE + WINDOW)).toBe(2);
        // 分钟 M+1 中段（elapsed=30s）：prev=1、cur=2 → 2 + 1*(1-0.5) = 2.5
        const mid = BASE + WINDOW + 30_000;
        expect(memoryRateLimitStore.incr("r1", mid)).toBeCloseTo(2.5);
    });

    it("cleanup removes keys idle beyond one window", () => {
        memoryRateLimitStore.incr("stale", BASE);
        memoryRateLimitStore.incr("fresh", BASE);
        // fresh 在 M+1 仍活跃
        memoryRateLimitStore.incr("fresh", BASE + WINDOW);
        // 在 M+2 清扫：stale 空闲 2 个窗口 → 回收；fresh 上一分钟活跃 → 保留
        memoryRateLimitStore.cleanup(BASE + 2 * WINDOW);
        expect(memoryRateLimitStore.size()).toBe(1);
        // stale 重新计数从 1 开始
        expect(memoryRateLimitStore.incr("stale", BASE + 2 * WINDOW)).toBe(1);
        // fresh 保留：M+1 的 curCount=1 降级为 prev，weighted = 1 + 1 = 2
        expect(memoryRateLimitStore.incr("fresh", BASE + 2 * WINDOW)).toBe(2);
    });
});
