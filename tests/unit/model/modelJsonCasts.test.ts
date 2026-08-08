import { describe, expect, it } from "vitest";
import {
    ModelFailoverConfig,
    ModelRoutingConfig,
    ModelUpstreamConfig,
    SgModel,
} from "../../../src/model/sgModel";

describe("model JSON custom casts", () => {
    it("casts routing_config to ModelRoutingConfig and nested upstream classes", () => {
        const model = new SgModel({
            routing_config: {
                upstreams: [{ vendor_id: 3, vendor_model_id: 7, enabled: true }],
            },
        });
        const config = model.getRoutingConfig();

        expect(config).toBeInstanceOf(ModelRoutingConfig);
        expect(config.upstreams[0]).toBeInstanceOf(ModelUpstreamConfig);
        expect(config.failover).toBeInstanceOf(ModelFailoverConfig);
        expect(config.toJSON()).toEqual({
            upstreams: [{ vendor_id: 3, vendor_model_id: 7, enabled: true }],
            failover: { enabled: true },
        });
    });

    it("defaults failover.enabled to true and respects an explicit value", () => {
        const model = new SgModel({
            routing_config: {
                upstreams: [{ vendor_id: 3, enabled: true }],
                failover: { enabled: false },
            },
        });

        expect(model.getRoutingConfig().failover.enabled).toBe(false);
        expect(model.getRoutingConfig().toJSON()).toEqual({
            upstreams: [{ vendor_id: 3, enabled: true }],
            failover: { enabled: false },
        });
    });
});
