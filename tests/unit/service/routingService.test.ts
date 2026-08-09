import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFormat, ModelRoutingMode } from "../../../src/constants";
import { SgModel } from "../../../src/model/sgModel";
import { SgVendor } from "../../../src/model/sgVendor";
import { ModelRoutingResult } from "../../../src/service/routingService/types";
import FirstAvailableRoutingStrategy from "../../../src/service/routingService/routingStrategy/firstAvailableRoutingStrategy";
import LoadBalanceRoutingStrategy from "../../../src/service/routingService/routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "../../../src/service/routingService/routingStrategy/singleRoutingStrategy";
import upstreamHealthService from "../../../src/service/upstreamHealthService";

function candidate(vendorId: number): ModelRoutingResult {
    return new ModelRoutingResult(
        { id: vendorId } as SgVendor,
        `model-${vendorId}`,
        [ApiFormat.OPENAI],
        ApiFormat.OPENAI,
    );
}


function model(mode: ModelRoutingMode): SgModel {
    return { routing_mode: mode } as SgModel;
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

    it("load balance selects each upstream with equal index probability", () => {
        const first = candidate(1);
        const second = candidate(2);
        const strategy = new LoadBalanceRoutingStrategy();
        vi.spyOn(Math, "random").mockReturnValue(0.75);

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE),
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
        expect(result.supportedFormats).toEqual([]);
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

    it("load_balance filters out cooling-down (DOWN) upstreams before selecting", () => {
        upstreamHealthService.markFailure(1, "model-1", ApiFormat.OPENAI, new Date());
        const strategy = new LoadBalanceRoutingStrategy();
        vi.spyOn(Math, "random").mockReturnValue(0.1);

        const result = strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE),
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
