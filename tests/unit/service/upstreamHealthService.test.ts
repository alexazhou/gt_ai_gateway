import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFormat, UPSTREAM_FAILURE_COOLDOWN_MS } from "../../../src/constants";
import upstreamHealthService, {
    UpstreamHealthState,
} from "../../../src/service/upstreamHealthService";
import type {
    UpstreamHealthRecord,
    UpstreamHealthStore,
} from "../../../src/util/health/sqlHealthStore";

const COOLDOWN = UPSTREAM_FAILURE_COOLDOWN_MS;
const BASE_NOW = 1_700_000_000_000;

function format(): ApiFormat {
    return ApiFormat.OPENAI;
}

function statusAt(vendorId: number, vendorModelName: string, now: number) {
    return upstreamHealthService.getHealthStatus(vendorId, vendorModelName, format(), now);
}

/** 内存版 store，模拟「另一个 isolate 写入的共享存储」 */
function fakeStore(initial: UpstreamHealthRecord[] = []): UpstreamHealthStore & {
    rows: Map<string, number>;
} {
    const rows = new Map<string, number>(initial.map((r) => [r.key, r.failedAt]));
    return {
        rows,
        async markFailure(key: string, failedAt: number) {
            rows.set(key, failedAt);
        },
        async listFailuresSince(since: number) {
            return [...rows.entries()]
                .filter(([, failedAt]) => failedAt >= since)
                .map(([key, failedAt]) => ({ key, failedAt }));
        },
        async prune(cutoff: number) {
            for (const [key, failedAt] of rows) {
                if (failedAt < cutoff) {
                    rows.delete(key);
                }
            }
        },
        async clear() {
            rows.clear();
        },
    };
}

const HEALTH_KEY = `upstream-health:3:claude-sonnet:${ApiFormat.OPENAI}`;

describe("upstreamHealthService", () => {
    beforeEach(async () => {
        await upstreamHealthService.clear();
    });

    afterEach(async () => {
        upstreamHealthService.setStore(null);
        await upstreamHealthService.clear();
        vi.restoreAllMocks();
    });

    it("reports a normal status before any failure", () => {
        expect(statusAt(3, "claude-sonnet", BASE_NOW)).toEqual({
            state: UpstreamHealthState.NORMAL,
            lastFailureAt: null,
        });
    });

    it("marks a failure and becomes down", async () => {
        await upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));

        expect(statusAt(3, "claude-sonnet", BASE_NOW)).toEqual({
            state: UpstreamHealthState.DOWN,
            lastFailureAt: BASE_NOW,
        });
    });

    it("recovers to normal after UPSTREAM_FAILURE_COOLDOWN_MS", async () => {
        await upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));

        expect(statusAt(3, "claude-sonnet", BASE_NOW + COOLDOWN - 1)).toEqual({
            state: UpstreamHealthState.DOWN,
            lastFailureAt: BASE_NOW,
        });
        expect(statusAt(3, "claude-sonnet", BASE_NOW + COOLDOWN)).toEqual({
            state: UpstreamHealthState.NORMAL,
            lastFailureAt: null,
        });
    });

    it("scopes state by vendor, model name, and api format", async () => {
        await upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));

        expect(statusAt(8, "claude-sonnet", BASE_NOW).state).toBe(UpstreamHealthState.NORMAL);
        expect(statusAt(3, "claude-opus", BASE_NOW).state).toBe(UpstreamHealthState.NORMAL);
        expect(statusAt(3, "claude-sonnet", BASE_NOW).state).toBe(UpstreamHealthState.DOWN);
        expect(
            upstreamHealthService.getHealthStatus(
                3,
                "claude-sonnet",
                ApiFormat.ANTHROPIC,
                BASE_NOW,
            ).state,
        ).toBe(UpstreamHealthState.NORMAL);
    });

    it("refreshes the failure time when a later failure is recorded", async () => {
        await upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));
        await upstreamHealthService.markFailure(
            3,
            "claude-sonnet",
            format(),
            new Date(BASE_NOW + 1000),
        );

        expect(statusAt(3, "claude-sonnet", BASE_NOW)).toEqual({
            state: UpstreamHealthState.DOWN,
            lastFailureAt: BASE_NOW + 1000,
        });
        // 原失败在 BASE_NOW + COOLDOWN 过期，但刷新后仍处于失效状态
        expect(statusAt(3, "claude-sonnet", BASE_NOW + COOLDOWN).state).toBe(UpstreamHealthState.DOWN);
        expect(statusAt(3, "claude-sonnet", BASE_NOW + 1000 + COOLDOWN).state).toBe(UpstreamHealthState.NORMAL);
    });

    it("shouldMarkFailure returns false for client-side 4xx errors", () => {
        for (const status of [400, 401, 403, 404, 429]) {
            expect(upstreamHealthService.shouldMarkFailure(status)).toBe(false);
        }
    });

    it("shouldMarkFailure returns true for server-side 5xx and 402 balance errors", () => {
        for (const status of [402, 500, 502, 503, 504]) {
            expect(upstreamHealthService.shouldMarkFailure(status)).toBe(true);
        }
    });

    it("shouldMarkFailure returns true for network errors (no http status)", () => {
        expect(upstreamHealthService.shouldMarkFailure(null)).toBe(true);
    });

    it("pruneExpired removes only expired upstream health entries", async () => {
        await upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));
        await upstreamHealthService.markFailure(8, "claude-opus", format(), new Date(BASE_NOW));

        const removed = await upstreamHealthService.pruneExpired(BASE_NOW + COOLDOWN);

        expect(removed).toBe(2);
        expect(statusAt(3, "claude-sonnet", BASE_NOW).lastFailureAt).toBeNull();
        expect(statusAt(8, "claude-opus", BASE_NOW).lastFailureAt).toBeNull();
    });

    // ---- P0-3：跨 isolate 共享（DB）与本地短 TTL 缓存 ----

    it("persists failures into the shared store", async () => {
        const store = fakeStore();
        upstreamHealthService.setStore(store);

        await upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));

        expect(store.rows.get(HEALTH_KEY)).toBe(BASE_NOW);
    });

    it("syncFromStore picks up failures written by another isolate", async () => {
        // 模拟另一个 isolate 已把失败落库，本 isolate 内存里还没有
        const store = fakeStore([{ key: HEALTH_KEY, failedAt: BASE_NOW }]);
        upstreamHealthService.setStore(store);

        expect(statusAt(3, "claude-sonnet", BASE_NOW).state).toBe(UpstreamHealthState.NORMAL);

        await upstreamHealthService.syncFromStore(BASE_NOW, true);

        expect(statusAt(3, "claude-sonnet", BASE_NOW)).toEqual({
            state: UpstreamHealthState.DOWN,
            lastFailureAt: BASE_NOW,
        });
    });

    it("syncFromStore is throttled by the local TTL unless forced", async () => {
        const store = fakeStore();
        upstreamHealthService.setStore(store);
        const listSpy = vi.spyOn(store, "listFailuresSince");

        await upstreamHealthService.syncFromStore(BASE_NOW, true);
        await upstreamHealthService.syncFromStore(BASE_NOW + 1, false);
        expect(listSpy).toHaveBeenCalledTimes(1);

        // TTL 过期后重新同步
        await upstreamHealthService.syncFromStore(BASE_NOW + 4_000, false);
        expect(listSpy).toHaveBeenCalledTimes(2);
    });

    it("syncFromStore drops local DOWN state that the store no longer reports", async () => {
        const store = fakeStore();
        upstreamHealthService.setStore(store);

        await upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));
        store.rows.clear();

        await upstreamHealthService.syncFromStore(BASE_NOW + 1, true);

        expect(statusAt(3, "claude-sonnet", BASE_NOW + 1).state).toBe(UpstreamHealthState.NORMAL);
    });

    it("keeps cooldown working when the store write fails", async () => {
        const store = fakeStore();
        vi.spyOn(store, "markFailure").mockRejectedValue(new Error("d1 down"));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        upstreamHealthService.setStore(store);

        await expect(
            upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW)),
        ).resolves.toBeUndefined();

        // 本地冷却仍然生效，不因为落库失败影响 failover
        expect(statusAt(3, "claude-sonnet", BASE_NOW).state).toBe(UpstreamHealthState.DOWN);
        expect(warnSpy).toHaveBeenCalled();
    });
});
