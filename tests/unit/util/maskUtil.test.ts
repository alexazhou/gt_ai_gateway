import { describe, expect, it } from "vitest";
import maskUtil from "../../../src/util/maskUtil";


describe("maskToken", () => {
    it("should keep first 4 chars and mask the rest", () => {
        expect(maskUtil.maskToken("abcdefgh")).toBe("abcd****");
    });

    it("should mask all chars when length <= 4", () => {
        expect(maskUtil.maskToken("abc")).toBe("***");
    });

    it("should return empty string for empty token", () => {
        expect(maskUtil.maskToken("")).toBe("");
    });

    it("should return empty string for undefined", () => {
        expect(maskUtil.maskToken(undefined as any)).toBe("");
    });
});