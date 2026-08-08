import { beforeEach, describe, expect, it } from "vitest";
import cacheService from "../../../src/service/cacheService";

describe("cacheService", () => {
    beforeEach(() => {
        cacheService.clear();
    });

    it("stores and retrieves values by key", () => {
        cacheService.set("k1", { value: 42 });

        expect(cacheService.get<{ value: number }>("k1")).toEqual({ value: 42 });
        expect(cacheService.get("missing")).toBeNull();
        expect(cacheService.has("k1")).toBe(true);
        expect(cacheService.has("missing")).toBe(false);
    });

    it("deletes values by key", () => {
        cacheService.set("k1", 1);

        expect(cacheService.del("k1")).toBe(true);
        expect(cacheService.has("k1")).toBe(false);
        expect(cacheService.del("k1")).toBe(false);
    });

    it("lists all entries and clears the store", () => {
        cacheService.set("a", 1);
        cacheService.set("b", 2);

        expect(cacheService.entries()).toEqual([
            ["a", 1],
            ["b", 2],
        ]);

        cacheService.clear();
        expect(cacheService.entries()).toEqual([]);
    });
});
