import { describe, expect, it } from "vitest";
import {
    ModelRoutingConfig,
    ModelUpstreamConfig,
    SgModel,
} from "../../../src/model/sgModel";
import {
    SgVendorModel,
    VendorModelHealth,
    VendorModelProtocolHealth,
} from "../../../src/model/sgVendorModel";
import { ApiFormat } from "../../../src/constants";

describe("model JSON custom casts", () => {
    it("casts routing_config to ModelRoutingConfig and nested upstream classes", () => {
        const config = ModelRoutingConfig.get(
            {} as SgModel,
            "routing_config",
            JSON.stringify({
                upstreams: [{ vendor_id: 3, vendor_model_id: 7, enabled: true }],
            }),
        );

        expect(config).toBeInstanceOf(ModelRoutingConfig);
        expect(config.upstreams[0]).toBeInstanceOf(ModelUpstreamConfig);
        expect(config.toJSON()).toEqual({
            upstreams: [{ vendor_id: 3, vendor_model_id: 7, enabled: true }],
        });
    });

    it("casts health to VendorModelHealth and protocol health classes", () => {
        const health = VendorModelHealth.get(
            {} as SgVendorModel,
            "health",
            JSON.stringify({
                openai: { last_failure_at: "2026-07-19T12:00:00.000Z" },
            }),
        );

        expect(health).toBeInstanceOf(VendorModelHealth);
        expect(health.getProtocolHealth(ApiFormat.OPENAI)).toBeInstanceOf(VendorModelProtocolHealth);
        expect(health.getLastFailureAt(ApiFormat.OPENAI)).toBe("2026-07-19T12:00:00.000Z");

        health.recordFailure(ApiFormat.ANTHROPIC, new Date("2026-07-19T13:00:00.000Z"));
        expect(health.toJSON()).toEqual({
            openai: { last_failure_at: "2026-07-19T12:00:00.000Z" },
            anthropic: { last_failure_at: "2026-07-19T13:00:00.000Z" },
        });
    });
});
