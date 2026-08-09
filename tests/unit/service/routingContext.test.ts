import { describe, expect, it } from "vitest";
import RoutingContext from "../../../src/service/routingService/routingContext";


describe("RoutingContext", () => {
    it("tracks tried upstreams by vendorId:vendorModelName", () => {
        const ctx = new RoutingContext();

        expect(ctx.hasTried(1, "model-a")).toBe(false);

        ctx.markTried(1, "model-a");

        expect(ctx.hasTried(1, "model-a")).toBe(true);
        // 不同 vendor 或不同模型名互不影响
        expect(ctx.hasTried(2, "model-a")).toBe(false);
        expect(ctx.hasTried(1, "model-b")).toBe(false);
    });

    it("is isolated between instances", () => {
        const first = new RoutingContext();
        const second = new RoutingContext();

        first.markTried(7, "shared-model");

        expect(first.hasTried(7, "shared-model")).toBe(true);
        expect(second.hasTried(7, "shared-model")).toBe(false);
    });
});
