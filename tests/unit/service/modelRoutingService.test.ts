import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRoutingMode } from "../../../src/constants";
import { SgModel } from "../../../src/model/sgModel";
import { SgVendorModel } from "../../../src/model/sgVendorModel";
import FailoverRoutingStrategy from "../../../src/service/routingStrategy/failoverRoutingStrategy";
import LoadBalanceRoutingStrategy from "../../../src/service/routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "../../../src/service/routingStrategy/singleRoutingStrategy";

function vendorModel(id: number): SgVendorModel {
    return { id } as SgVendorModel;
}


function model(mode: ModelRoutingMode): SgModel {
    return { routing_mode: mode } as SgModel;
}


afterEach(() => {
    vi.restoreAllMocks();
});


describe("routing strategies", () => {
    it("single selects its only upstream", () => {
        const upstream = vendorModel(1);
        const strategy = new SingleRoutingStrategy();

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.SINGLE),
            [upstream],
        )).toBe(upstream);
    });

    it("load balance selects each upstream with equal index probability", () => {
        const first = vendorModel(1);
        const second = vendorModel(2);
        const strategy = new LoadBalanceRoutingStrategy();
        vi.spyOn(Math, "random").mockReturnValue(0.75);

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.LOAD_BALANCE),
            [first, second],
        )).toBe(second);
    });

    it("failover selects the first healthy upstream in configuration order", () => {
        const first = vendorModel(1);
        const second = vendorModel(2);
        const strategy = new FailoverRoutingStrategy();

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.FAILOVER),
            [first, second],
        )).toBe(first);
    });

    it("returns null when no healthy upstream remains", () => {
        const strategy = new FailoverRoutingStrategy();

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.FAILOVER),
            [],
        )).toBeNull();
    });
});
