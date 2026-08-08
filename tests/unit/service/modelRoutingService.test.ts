import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFormat, ModelRoutingMode } from "../../../src/constants";
import { SgModel } from "../../../src/model/sgModel";
import { ModelRoutingResult } from "../../../src/service/routingStrategy/baseRoutingStrategy";
import FirstAvailableRoutingStrategy from "../../../src/service/routingStrategy/firstAvailableRoutingStrategy";
import LoadBalanceRoutingStrategy from "../../../src/service/routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "../../../src/service/routingStrategy/singleRoutingStrategy";

function candidate(vendorId: number): ModelRoutingResult {
    return new ModelRoutingResult(vendorId, `model-${vendorId}`, [ApiFormat.OPENAI]);
}


function model(mode: ModelRoutingMode): SgModel {
    return { routing_mode: mode } as SgModel;
}


afterEach(() => {
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
        expect(result.vendorId).toBeNull();
        expect(result.vendorModelName).toBeNull();
        expect(result.supportedFormats).toEqual([]);
    });
});
