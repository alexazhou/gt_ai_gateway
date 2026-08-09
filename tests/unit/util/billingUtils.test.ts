import { describe, expect, it } from "vitest";
import billingUtils from "../../../src/util/billingUtils";

const UNIT = 0.000001;

describe("billingUtils", () => {
    it("quantizeAmount keeps zero as free", () => {
        expect(billingUtils.quantizeAmount(0)).toBe(0);
        expect(billingUtils.quantizeAmount(-1)).toBe(0);
    });

    it("quantizeAmount charges at least one minimum unit for any positive cost", () => {
        expect(billingUtils.quantizeAmount(1e-10)).toBe(UNIT);
        expect(billingUtils.quantizeAmount(0.4e-6)).toBe(UNIT);
    });

    it("quantizeAmount rounds to the nearest minimum-unit multiple", () => {
        expect(billingUtils.quantizeAmount(1.4e-6)).toBe(UNIT);
        expect(billingUtils.quantizeAmount(1.6e-6)).toBe(2 * UNIT);
        expect(billingUtils.quantizeAmount(0.0000135988)).toBeCloseTo(14e-6, 12);
    });
});
