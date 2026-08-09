import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFormat, ModelRoutingMode } from "../../../src/constants";
import { SgModel } from "../../../src/model/sgModel";
import { SgVendor } from "../../../src/model/sgVendor";
import { ModelRoutingResult } from "../../../src/service/routingService/types";
import FirstAvailableRoutingStrategy from "../../../src/service/routingService/routingStrategy/firstAvailableRoutingStrategy";
import LoadBalanceRoutingStrategy from "../../../src/service/routingService/routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "../../../src/service/routingService/routingStrategy/singleRoutingStrategy";

function candidate(vendorId: number): ModelRoutingResult {
    return new ModelRoutingResult({ id: vendorId } as SgVendor, `model-${vendorId}`, [ApiFormat.OPENAI]);
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
        expect(result.vendor).toBeNull();
        expect(result.vendorModelName).toBeNull();
        expect(result.supportedFormats).toEqual([]);
    });

    it("hasUpstream reflects whether the result carries an upstream", () => {
        expect(candidate(1).hasUpstream()).toBe(true);
        expect(ModelRoutingResult.none().hasUpstream()).toBe(false);
    });
});
