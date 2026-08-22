import { describe, it, expect } from "vitest";
import { SgRecordUsage } from "../../../src/model/sgRecord";


function castGet(value: string | null): SgRecordUsage | null {
    return SgRecordUsage.get(null as any, "usage", value);
}


describe("SgRecordUsage cast", () => {
    it("parses v1 legacy storage (no version marker) as non-cached display口径", () => {
        const u = castGet(JSON.stringify({ prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 50 }));

        expect(u).not.toBeNull();
        expect(u!.version).toBe(1);
        expect(u!.toJSON()).toEqual({
            prompt_tokens: 100,
            completion_tokens: 20,
            cache_read_tokens: 50,
        });
    });

    it("parses v2 storage and normalizes total prompt_tokens to non-cached display口径", () => {
        const u = castGet(JSON.stringify({
            usage_version: 2,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
        }));

        expect(u).not.toBeNull();
        expect(u!.version).toBe(2);
        expect(u!.toJSON()).toEqual({
            prompt_tokens: 100,
            completion_tokens: 20,
            cache_read_tokens: 50,
        });
    });

    it("preserves null for fields upstream did not return (distinguishes from 0)", () => {
        const u = castGet(JSON.stringify({
            usage_version: 2,
            prompt_tokens: 150,
            completion_tokens: 20,
        }));

        expect(u!.toJSON()).toEqual({
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: null,
        });
    });

    it("keeps prompt_tokens null when upstream did not return it (v2)", () => {
        const u = castGet(JSON.stringify({ usage_version: 2, completion_tokens: 20 }));

        expect(u!.toJSON()).toEqual({
            prompt_tokens: null,
            completion_tokens: 20,
            cache_read_tokens: null,
        });
    });

    it("preserves explicit 0 from upstream (not collapsed to null)", () => {
        const u = castGet(JSON.stringify({
            usage_version: 2,
            prompt_tokens: 0,
            completion_tokens: 20,
            cache_read_tokens: 0,
        }));

        expect(u!.toJSON()).toEqual({
            prompt_tokens: 0,
            completion_tokens: 20,
            cache_read_tokens: 0,
        });
    });

    it("keeps cache_creation_tokens in display when present (v2)", () => {
        const u = castGet(JSON.stringify({
            usage_version: 2,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
            cache_creation_tokens: 15,
        }));

        expect(u!.toJSON()).toEqual({
            prompt_tokens: 100,
            completion_tokens: 20,
            cache_read_tokens: 50,
            cache_creation_tokens: 15,
        });
    });

    it("returns null for null / empty / invalid storage", () => {
        expect(castGet(null)).toBeNull();
        expect(castGet("")).toBeNull();
        expect(castGet("not-json")).toBeNull();
    });

    it("set() serializes instance back to storage form with version marker", () => {
        const u = castGet(JSON.stringify({
            usage_version: 2,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
        }));
        const stored = SgRecordUsage.set(null as any, "usage", u);

        expect(JSON.parse(stored!)).toEqual({
            usage_version: 2,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
        });
    });
});