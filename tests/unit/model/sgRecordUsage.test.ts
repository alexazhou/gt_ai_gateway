import { describe, it, expect } from "vitest";
import { SgRecordUsage } from "../../../src/model/sgRecord";


function castGet(value: string | null): SgRecordUsage | null {
    return SgRecordUsage.get(null as any, "usage", value);
}


describe("SgRecordUsage cast", () => {
    it("parses v1 legacy storage: 非缓存基数补上缓存，输出 OpenAI 总量口径", () => {
        const u = castGet(JSON.stringify({ prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 50 }));

        expect(u).not.toBeNull();
        expect(u!.version).toBe(1);
        // v1 存的是非缓存输入（100），总量 = 100 + 50
        expect(u!.toJSON()).toEqual({
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
        });
    });

    it("parses v2 storage: prompt_tokens 已是总量，原样输出（含缓存）", () => {
        const u = castGet(JSON.stringify({
            usage_version: 2,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
        }));

        expect(u).not.toBeNull();
        expect(u!.version).toBe(2);
        expect(u!.toJSON()).toEqual({
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
        });
    });

    it("parses v3 storage: prompt_tokens 已含 cache_creation，原样输出（与 v2 读取行为一致）", () => {
        const u = castGet(JSON.stringify({
            usage_version: 3,
            prompt_tokens: 155,
            completion_tokens: 20,
            cache_read_tokens: 40,
            cache_creation_tokens: 15,
        }));

        expect(u).not.toBeNull();
        expect(u!.version).toBe(3);
        // v3 存的就是「非缓存 + cache_read + cache_creation」总量，读取侧不再做任何加法
        expect(u!.toJSON()).toEqual({
            prompt_tokens: 155,
            completion_tokens: 20,
            cache_read_tokens: 40,
            cache_creation_tokens: 15,
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
            prompt_tokens: 150,
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
            usage_version: 3,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
        });
    });

    it("toStorageJSON keeps cache_creation_tokens when present", () => {
        const u = castGet(JSON.stringify({
            usage_version: 2,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
            cache_creation_tokens: 15,
        }));

        // 内部字段已是总量 150，存储原样写回
        expect(u!.toStorageJSON()).toEqual({
            usage_version: 3,
            prompt_tokens: 150,
            completion_tokens: 20,
            cache_read_tokens: 50,
            cache_creation_tokens: 15,
        });
    });

    it("set() returns null for null input", () => {
        expect(SgRecordUsage.set(null as any, "usage", null)).toBeNull();
    });
});