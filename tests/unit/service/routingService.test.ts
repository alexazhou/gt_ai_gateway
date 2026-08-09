import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFormat, ModelRoutingMode } from "../../../src/constants";
import { SgModel } from "../../../src/model/sgModel";
import { SgVendor } from "../../../src/model/sgVendor";
import { ModelRoutingResult } from "../../../src/service/routingService/types";
import RoutingContext from "../../../src/service/routingService/routingContext";
import FirstAvailableRoutingStrategy from "../../../src/service/routingService/routingStrategy/firstAvailableRoutingStrategy";
import LoadBalanceRoutingStrategy from "../../../src/service/routingService/routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "../../../src/service/routingService/routingStrategy/singleRoutingStrategy";
import upstreamHealthService from "../../../src/service/upstreamHealthService";

function candidate(vendorId: number): ModelRoutingResult {
    return new ModelRoutingResult(
        { id: vendorId } as SgVendor,
        `model-${vendorId}`,
        ApiFormat.OPENAI,
    );
}

function freshRoutingContext(): RoutingContext {
    return new RoutingContext();
}


function model(mode: ModelRoutingMode, loadBalanceStrategy: "user" | "request" = "user"): SgModel {
    return {
        routing_mode: mode,
        getRoutingConfig: () => ({ load_balance_strategy: loadBalanceStrategy }),
    } as unknown as SgModel;
}


beforeEach(() => {
    upstreamHealthService.clear();
});

afterEach(() => {
    upstreamHealthService.clear();
    vi.restoreAllMocks();
});


describe("routing strategies", () => {
    it("single selects its only upstream", () => {
        const first = candidate(1);
        const strategy = new SingleRoutingStrategy();

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.SINGLE),
            [first],
        )).toBe(first);
    });

    it("load_balance (按用户随机) is deterministic for the same user seed", () => {
        const strategy = new LoadBalanceRoutingStrategy();
        const candidates = [candidate(1), candidate(2), candidate(3)];

        const r1 = strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE, "user"),
            candidates,
            freshRoutingContext(),
            42,
        );
        const r2 = strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE, "user"),
            candidates,
            freshRoutingContext(),
            42,
        );
        expect(r1.vendor).not.toBeNull();
        expect(r1.vendor?.id).toBe(r2.vendor?.id);
    });

    it("load_balance (按用户随机) distributes across users (different seeds)", () => {
        const strategy = new LoadBalanceRoutingStrategy();
        const candidates = [candidate(1), candidate(2), candidate(3)];
        const chosen = new Set<number>();

        for (let seed = 1; seed <= 50; seed++) {
            const result = strategy.selectUpstream(
                model(ModelRoutingMode.LOAD_BALANCE, "user"),
                candidates,
                freshRoutingContext(),
                seed,
            );
            chosen.add(result.vendor!.id);
        }
        expect(chosen.size).toBeGreaterThan(1);
    });

    it("load_balance (按请求随机) selects randomly via Math.random", () => {
        const first = candidate(1);
        const second = candidate(2);
        const strategy = new LoadBalanceRoutingStrategy();
        vi.spyOn(Math, "random").mockReturnValue(0.75);

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE, "request"),
            [first, second],
        )).toBe(second);
    });

    it("first_available selects the first healthy upstream in configuration order", () => {
        const first = candidate(1);
        const second = candidate(2);
        const strategy = new FirstAvailableRoutingStrategy();

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.FIRST_AVAILABLE),
            [first, second],
        )).toBe(first);
    });

    it("returns an empty result (upstream null) when no healthy upstream remains", () => {
        const strategy = new FirstAvailableRoutingStrategy();

        const result = strategy.selectUpstream(
            model(ModelRoutingMode.FIRST_AVAILABLE),
            [],
        );
        expect(result.vendor).toBeNull();
        expect(result.vendorModelName).toBeNull();
    });

    it("hasUpstream reflects whether the result carries an upstream", () => {
        expect(candidate(1).hasUpstream()).toBe(true);
        expect(ModelRoutingResult.none().hasUpstream()).toBe(false);
    });

    it("first_available filters out cooling-down (DOWN) upstreams", () => {
        upstreamHealthService.markFailure(1, "model-1", ApiFormat.OPENAI, new Date());
        const strategy = new FirstAvailableRoutingStrategy();

        const result = strategy.selectUpstream(
            model(ModelRoutingMode.FIRST_AVAILABLE),
            [candidate(1), candidate(2)],
        );
        expect(result.vendor?.id).toBe(2);
    });

    it("load_balance (按用户随机) skips cooling-down (DOWN) upstreams", () => {
        upstreamHealthService.markFailure(1, "model-1", ApiFormat.OPENAI, new Date());
        const strategy = new LoadBalanceRoutingStrategy();

        const result = strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE, "user"),
            [candidate(1), candidate(2)],
            freshRoutingContext(),
            1,
        );
        expect(result.vendor?.id).toBe(2);
    });

    it("strategies skip upstreams already tried in this request (failover protection)", () => {
        const candidates = [candidate(1), candidate(2), candidate(3)];
        const routingContext = freshRoutingContext();
        routingContext.markTried(1, "model-1");

        // first_available 跳过已试过的 candidate(1)
        const faResult = new FirstAvailableRoutingStrategy().selectUpstream(
            model(ModelRoutingMode.FIRST_AVAILABLE),
            candidates,
            routingContext,
        );
        expect(faResult.vendor?.id).toBe(2);

        // single 也跳过已试过的（避免 failover 死循环）
        const singleResult = new SingleRoutingStrategy().selectUpstream(
            model(ModelRoutingMode.SINGLE),
            candidates,
            routingContext,
        );
        expect(singleResult.vendor?.id).toBe(2);

        // load_balance 按用户随机跳过已试过的 candidate(1)
        const lbResult = new LoadBalanceRoutingStrategy().selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE, "user"),
            candidates,
            routingContext,
            1,
        );
        expect(lbResult.vendor?.id).not.toBe(1);
    });

    it("strategies return none when all upstreams are already tried", () => {
        const candidates = [candidate(1), candidate(2)];
        const routingContext = freshRoutingContext();
        routingContext.markTried(1, "model-1");
        routingContext.markTried(2, "model-2");

        const result = new FirstAvailableRoutingStrategy().selectUpstream(
            model(ModelRoutingMode.FIRST_AVAILABLE),
            candidates,
            routingContext,
        );
        expect(result.vendor).toBeNull();
    });

    it("load_balance (按请求随机) skips cooling-down (DOWN) upstreams", () => {
        upstreamHealthService.markFailure(1, "model-1", ApiFormat.OPENAI, new Date());
        const strategy = new LoadBalanceRoutingStrategy();
        vi.spyOn(Math, "random").mockReturnValue(0.1);

        const result = strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE, "request"),
            [candidate(1), candidate(2)],
        );
        expect(result.vendor?.id).toBe(2);
    });

    it("single ignores health status and returns the fixed upstream", () => {
        upstreamHealthService.markFailure(1, "model-1", ApiFormat.OPENAI, new Date());
        const strategy = new SingleRoutingStrategy();

        const result = strategy.selectUpstream(
            model(ModelRoutingMode.SINGLE),
            [candidate(1)],
        );
        expect(result.vendor?.id).toBe(1);
    });
});
