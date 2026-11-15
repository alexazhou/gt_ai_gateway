/**
 * stop_reason 来源标记（#249）单元测试
 *
 * 覆盖三层：
 * 1. `stopReasonSourceUtil` 的三个纯函数（含「无转换器 ⇒ upstream」「确定不了 ⇒ 不写键」两条口径）
 * 2. `AnthropicToOpenAIConverter` 在流式/非流式的收尾点是否正确记下来源
 * 3. 每个 converter 实例各记各的（并发不串味的最小证明）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AnthropicToOpenAIConverter } from "../../../src/util/protocolConverter/AnthropicToOpenAIConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import type { BaseConverter } from "../../../src/util/protocolConverter/BaseConverter";
import stopReasonSourceUtil from "../../../src/util/protocolUtil/stopReasonSourceUtil";
import { ApiFormat } from "../../../src/constants";

/** 只实现 getStopReasonSource 的假转换器，用来验 util 的分支（不依赖任何真实转换逻辑） */
function fakeConverter(source: "upstream" | "synthesized" | null): BaseConverter {
    return { getStopReasonSource: () => source } as unknown as BaseConverter;
}

describe("stopReasonSourceUtil - 纯函数口径", () => {
    it("无转换器（同协议直通）⇒ upstream：我方没有 stop_reason 合成点", () => {
        expect(stopReasonSourceUtil.resolveStopReasonSource(null)).toBe("upstream");
        expect(stopReasonSourceUtil.stopReasonDetailsForConverter(null)).toEqual({ stop_reason_source: "upstream" });
    });

    it("转换器已确定来源 ⇒ 原样透传 upstream / synthesized", () => {
        expect(stopReasonSourceUtil.resolveStopReasonSource(fakeConverter("upstream"))).toBe("upstream");
        expect(stopReasonSourceUtil.resolveStopReasonSource(fakeConverter("synthesized"))).toBe("synthesized");
        expect(stopReasonSourceUtil.stopReasonDetailsForConverter(fakeConverter("synthesized"))).toEqual({
            stop_reason_source: "synthesized",
        });
    });

    it("转换器还没走到收尾点（null）⇒ 不写这个键（宁可缺，不写错的）", () => {
        expect(stopReasonSourceUtil.resolveStopReasonSource(fakeConverter(null))).toBeNull();
        expect(stopReasonSourceUtil.stopReasonDetailsForConverter(fakeConverter(null))).toEqual({});
        expect(stopReasonSourceUtil.stopReasonSourceDetail(null)).toEqual({});
        expect(stopReasonSourceUtil.stopReasonSourceDetail("upstream")).toEqual({ stop_reason_source: "upstream" });
    });
});

describe("AnthropicToOpenAIConverter - 收尾点记来源", () => {
    let converter: AnthropicToOpenAIConverter;

    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            model: "gpt-4",
            choices: [{ index: 0, delta, finish_reason: finish }],
        });

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4") as AnthropicToOpenAIConverter;
    });

    it("初始为 null：还没走到任何收尾点", () => {
        expect(converter.getStopReasonSource()).toBeNull();
    });

    it("上游给了 finish_reason ⇒ upstream（[DONE] 收尾路径）", () => {
        converter.convertStreamEvent(chunk({ role: "assistant" }));
        converter.convertStreamEvent(chunk({ content: "hi" }));
        converter.convertStreamEvent(chunk({}, "stop"));
        // 判决点只有一个：收尾（[DONE] / EOF）时由 handleDoneEvent 统一落定，
        // 前置的 finish_reason 帧只暂存 pendingStopReason，不在这里提前标记
        expect(converter.getStopReasonSource()).toBeNull();

        converter.convertStreamEvent("[DONE]");
        // [DONE] 消费完仍保持 upstream（不是被兜底覆盖成 synthesized）
        expect(converter.getStopReasonSource()).toBe("upstream");
    });

    it("上游给了 finish_reason 但没发 [DONE]（EOF 收尾）⇒ 仍是 upstream", () => {
        converter.convertStreamEvent(chunk({ role: "assistant" }));
        converter.convertStreamEvent(chunk({ content: "hi" }));
        converter.convertStreamEvent(chunk({}, "length"));
        converter.onUpstreamEnd();
        expect(converter.getStopReasonSource()).toBe("upstream");
    });

    it("上游漏发 finish_reason 直接 [DONE] ⇒ synthesized（#246 D2 的兜底路径）", () => {
        converter.convertStreamEvent(chunk({ role: "assistant" }));
        converter.convertStreamEvent(chunk({ content: "hi" }));
        converter.convertStreamEvent("[DONE]");
        expect(converter.getStopReasonSource()).toBe("synthesized");
    });

    it("非流式：上游缺 finish_reason ⇒ synthesized；给了 ⇒ upstream", () => {
        const base = {
            id: "chatcmpl-x",
            object: "chat.completion",
            model: "gpt-4",
            choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
        };

        const noFinish = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4") as AnthropicToOpenAIConverter;
        noFinish.convertResponse({ ...base, choices: [{ ...base.choices[0], finish_reason: null }] } as any);
        expect(noFinish.getStopReasonSource()).toBe("synthesized");

        const withFinish = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4") as AnthropicToOpenAIConverter;
        withFinish.convertResponse({ ...base, choices: [{ ...base.choices[0], finish_reason: "stop" }] } as any);
        expect(withFinish.getStopReasonSource()).toBe("upstream");
    });

    it("两个实例各记各的：一个走兜底不影响另一个（并发不串味）", () => {
        const a = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4") as AnthropicToOpenAIConverter;
        const b = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI, "gpt-4") as AnthropicToOpenAIConverter;

        a.convertStreamEvent(chunk({ role: "assistant" }));
        a.convertStreamEvent("[DONE]");

        b.convertStreamEvent(chunk({ role: "assistant" }));
        b.convertStreamEvent(chunk({ content: "hi" }));
        b.convertStreamEvent(chunk({}, "stop"));
        b.convertStreamEvent("[DONE]");

        expect(a.getStopReasonSource()).toBe("synthesized");
        expect(b.getStopReasonSource()).toBe("upstream");
    });
});
