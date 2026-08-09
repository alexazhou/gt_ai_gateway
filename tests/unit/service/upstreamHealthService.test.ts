import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiFormat, UPSTREAM_FAILURE_COOLDOWN_MS } from "../../../src/constants";
import upstreamHealthService, {
    UpstreamHealthState,
} from "../../../src/service/upstreamHealthService";

const COOLDOWN = UPSTREAM_FAILURE_COOLDOWN_MS;
const BASE_NOW = 1_700_000_000_000;

function format(): ApiFormat {
    return ApiFormat.OPENAI;
}

function statusAt(vendorId: number, vendorModelName: string, now: number) {
    return upstreamHealthService.getHealthStatus(vendorId, vendorModelName, format(), now);
}

describe("upstreamHealthService", () => {
    beforeEach(() => {
        upstreamHealthService.clear();
    });

    afterEach(() => {
        upstreamHealthService.clear();
    });

    it("reports a normal status before any failure", () => {
        expect(statusAt(3, "claude-sonnet", BASE_NOW)).toEqual({
            state: UpstreamHealthState.NORMAL,
            lastFailureAt: null,
        });
    });

    it("marks a failure and becomes down", () => {
        upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));

        expect(statusAt(3, "claude-sonnet", BASE_NOW)).toEqual({
            state: UpstreamHealthState.DOWN,
            lastFailureAt: BASE_NOW,
        });
    });

    it("recovers to normal after UPSTREAM_FAILURE_COOLDOWN_MS", () => {
        upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));

        expect(statusAt(3, "claude-sonnet", BASE_NOW + COOLDOWN - 1)).toEqual({
            state: UpstreamHealthState.DOWN,
            lastFailureAt: BASE_NOW,
        });
        expect(statusAt(3, "claude-sonnet", BASE_NOW + COOLDOWN)).toEqual({
            state: UpstreamHealthState.NORMAL,
            lastFailureAt: null,
        });
    });

    it("scopes state by vendor, model name, and api format", () => {
        upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));

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

    it("refreshes the failure time when a later failure is recorded", () => {
        upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));
        upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW + 1000));

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

    it("pruneExpired removes only expired upstream health entries", () => {
        upstreamHealthService.markFailure(3, "claude-sonnet", format(), new Date(BASE_NOW));
        upstreamHealthService.markFailure(8, "claude-opus", format(), new Date(BASE_NOW));

        const removed = upstreamHealthService.pruneExpired(BASE_NOW + COOLDOWN);

        expect(removed).toBe(2);
        expect(statusAt(3, "claude-sonnet", BASE_NOW).lastFailureAt).toBeNull();
        expect(statusAt(8, "claude-opus", BASE_NOW).lastFailureAt).toBeNull();
    });
});
