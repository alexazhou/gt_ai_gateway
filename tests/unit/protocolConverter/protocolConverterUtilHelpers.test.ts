import { describe, it, expect } from "vitest";
import protocolConverterUtil from "../../../src/util/protocolConverter/protocolConverterUtil";

/**
 * protocolConverterUtil 里"只被某个协议组合间接调用"的几个纯函数。
 *
 * 这些位置的失效是静默的：usage 的 cache_write / cache_creation 少合并一个字段 →
 * 账单上缓存写入的 token 直接消失；图片 data URL 拆错 → 上游 400 或图片丢失；
 * input_file 静默返回空串 → 用户附件内容凭空蒸发。
 */

const { mergeOpenAIUsage, mergeAnthropicUsage, mergeResponsesUsage } = protocolConverterUtil;
const { extractResponsesText, anthropicImageSourceToUrl, anthropicImageSourceFromUrl } = protocolConverterUtil;

describe("usage 合并：逐字段保留旧值，显式 0 覆盖旧值", () => {
    it("OpenAI：prompt_tokens_details.cache_write_tokens 会被合并（缓存写入不丢账）", () => {
        const merged = mergeOpenAIUsage(
            { prompt_tokens: 100, cached_tokens: 10 },
            {
                prompt_tokens: 120,
                prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 7 },
            } as any,
        );

        expect(merged).toMatchObject({
            prompt_tokens: 120,
            cached_tokens: 20,
            cache_write_tokens: 7,
        });
    });

    it("OpenAI：source 为 null / undefined 时原样返回 target（不清零已有计数）", () => {
        const target = { prompt_tokens: 5, completion_tokens: 6 };
        expect(mergeOpenAIUsage(target, null)).toBe(target);
        expect(mergeOpenAIUsage(target, undefined)).toBe(target);
        expect(target).toEqual({ prompt_tokens: 5, completion_tokens: 6 });
    });

    it("OpenAI：显式 0 覆盖旧值（不是「没有就不覆盖」）", () => {
        const merged = mergeOpenAIUsage({ prompt_tokens: 100, reasoning_tokens: 9 }, {
            prompt_tokens: 0,
            completion_tokens_details: { reasoning_tokens: 0 },
        } as any);

        expect(merged.prompt_tokens).toBe(0);
        expect(merged.reasoning_tokens).toBe(0);
    });

    it("Anthropic：cache_creation_input_tokens 会被合并（缓存写入不丢账）", () => {
        const merged = mergeAnthropicUsage(
            { input_tokens: 10, cache_read_input_tokens: 3 },
            { input_tokens: 11, cache_read_input_tokens: 4, cache_creation_input_tokens: 6 } as any,
        );

        expect(merged).toEqual({
            input_tokens: 11,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 6,
        });
    });

    it("Anthropic：显式 0 覆盖旧值", () => {
        const merged = mergeAnthropicUsage({ cache_creation_input_tokens: 6 }, {
            cache_creation_input_tokens: 0,
        } as any);

        expect(merged.cache_creation_input_tokens).toBe(0);
    });

    it("Responses：input/output 明细分别映射到 cached / reasoning", () => {
        const merged = mergeResponsesUsage({ total_tokens: 1 }, {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 1 },
        } as any);

        expect(merged).toEqual({
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            cached_tokens: 4,
            reasoning_tokens: 1,
        });
    });
});

describe("extractResponsesText：input_file 不能静默丢", () => {
    it("input_text / output_text 段以换行拼接", () => {
        const text = extractResponsesText(
            [
                { type: "input_text", text: "第一段" },
                { type: "output_text", text: "第二段" },
            ] as any,
            "Anthropic",
        );

        expect(text).toBe("第一段\n第二段");
    });

    it("纯字符串内容直接返回", () => {
        expect(extractResponsesText("hello", "OpenAI")).toBe("hello");
    });

    it("input_file 段 → AppError 400（消息点明无法转换，且带目标协议）", () => {
        expect(() =>
            extractResponsesText(
                [
                    { type: "input_text", text: "看这个文件" },
                    { type: "input_file", file_id: "file-1" },
                ] as any,
                "Anthropic",
            ),
        ).toThrowError(/Responses input_file cannot be converted to Anthropic/);

        try {
            extractResponsesText([{ type: "input_file", file_id: "f" }] as any, "OpenAI");
            throw new Error("应当抛错");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
            expect(e.message).toContain("to OpenAI");
        }
    });
});

describe("图片 source ↔ URL 互转", () => {
    it("base64 source → data URL；缺 media_type 时兜底 image/png", () => {
        expect(anthropicImageSourceToUrl({ type: "base64", media_type: "image/jpeg", data: "AAA" } as any)).toBe(
            "data:image/jpeg;base64,AAA",
        );
        expect(anthropicImageSourceToUrl({ type: "base64", data: "BBB" } as any)).toBe("data:image/png;base64,BBB");
    });

    it("url source → 原样透传", () => {
        expect(anthropicImageSourceToUrl({ type: "url", url: "https://x/y.png" } as any)).toBe("https://x/y.png");
    });

    it("没有可用 source → AppError 400（不静默丢图）", () => {
        for (const src of [undefined, { type: "base64" } as any, { type: "url" } as any]) {
            try {
                anthropicImageSourceToUrl(src);
                throw new Error("应当抛错");
            } catch (e: any) {
                expect(e.statusCode).toBe(400);
                expect(e.message).toContain("requires a valid source");
            }
        }
    });

    it("data:image/...;base64,xxx → 拆成 base64 source", () => {
        expect(anthropicImageSourceFromUrl("data:image/webp;base64,ZZZ")).toEqual({
            type: "base64",
            media_type: "image/webp",
            data: "ZZZ",
        });
    });

    it("非 data: 的普通 URL → url source 透传", () => {
        expect(anthropicImageSourceFromUrl("https://x/y.png")).toEqual({
            type: "url",
            url: "https://x/y.png",
        });
    });

    it("data: 但不是 base64 形式 → AppError 400（不当作远程 URL 送上游）", () => {
        expect(() => anthropicImageSourceFromUrl("data:text/plain,hello")).toThrowError(
            /expected data:<mime>;base64,<data>/,
        );
        try {
            anthropicImageSourceFromUrl("data:image/png;charset=utf8,xxx");
            throw new Error("应当抛错");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
        }
    });
});

describe("验签凭据的段结构校验", () => {
    it("前缀正确但 payload 段为空 → null（不是把空串当载荷去 JSON.parse）", () => {
        expect(protocolConverterUtil.unsealThinkingSignature("gw_sig_v1..", "anthropic")).toBeNull();
        expect(protocolConverterUtil.unsealThinkingSignature("gw_sig_v1..abcdef", "anthropic")).toBeNull();
    });

    it("前缀正确但 MAC 段为空 → null", () => {
        expect(protocolConverterUtil.unsealThinkingSignature("gw_sig_v1.abcdef.", "anthropic")).toBeNull();
    });

    it("段数不是 3 → null", () => {
        expect(protocolConverterUtil.unsealThinkingSignature("gw_sig_v1.a.b.c", "anthropic")).toBeNull();
    });

    it("前缀不符（含空串）→ null", () => {
        expect(protocolConverterUtil.unsealThinkingSignature("", "anthropic")).toBeNull();
        expect(protocolConverterUtil.unsealThinkingSignature("other.a.b", "anthropic")).toBeNull();
    });
});
