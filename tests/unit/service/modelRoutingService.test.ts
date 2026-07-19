import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFormat, ModelRoutingMode } from "../../../src/constants";
import { SgModel } from "../../../src/model/sgModel";
import { RoutingCandidate } from "../../../src/service/routingStrategy/baseRoutingStrategy";
import FailoverRoutingStrategy from "../../../src/service/routingStrategy/failoverRoutingStrategy";
import LoadBalanceRoutingStrategy from "../../../src/service/routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "../../../src/service/routingStrategy/singleRoutingStrategy";

function candidate(id: number): RoutingCandidate {
    return {
        vendorModel: { id } as any,
        upstreamFormat: ApiFormat.OPENAI,
    };
}


function model(mode: ModelRoutingMode): SgModel {
    return { routing_mode: mode } as SgModel;
}


afterEach(() => {
    vi.restoreAllMocks();
});


describe("routing strategies", () => {
    it("single selects its only upstream", () => {
        const upstream = candidate(1);
        const strategy = new SingleRoutingStrategy();

        expect(strategy.selectUpstream(
            model(ModelRoutingMode.SINGLE),
            [upstream],
        )).toBe(upstream);
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

    it("failover selects the first healthy upstream in configuration order", () => {
        const first = candidate(1);
        const second = candidate(2);
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
