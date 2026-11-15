import { describe, it, expect } from "vitest";
import { ApiFormat } from "../../../../src/constants";
import { UpstreamUsageCollector } from "../../../../src/util/protocolUtil/usageUtil";

/**
 * `UpstreamUsageCollector`：流式路径下把「上游 usage 增量」累积成完整 usage。
 *
 * 为什么要单独锁：三种 wire format 的 usage **事件位置与字段名都不同**——
 * OpenAI 在 `chunk.usage`，Anthropic 在 `message_start.message.usage` / `message_delta.usage`，
 * Responses 在 `response.completed.response.usage`。这里按 format 分支读不同键，
 * 读错了不会报错，只会静默少计费（缓存读写 token 尤其容易丢）。
 */
describe("UpstreamUsageCollector（流式 usage 累积）", () => {
    it("忽略空串、[DONE] 与非法 JSON，且不把 hasUsage 置真", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.OPENAI);

        collector.addEvent("");
        collector.addEvent("[DONE]");
        collector.addEvent("{not json");

        expect(collector.getUsage()).toBeNull();
    });

    it("非对象 JSON（字符串/数字/null）不参与累积", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.OPENAI);

        collector.addEvent(JSON.stringify("just a string"));
        collector.addEvent(JSON.stringify(42));
        collector.addEvent(JSON.stringify(null));

        expect(collector.getUsage()).toBeNull();
    });

    it("OpenAI：累积 prompt/completion 与 prompt_tokens_details 的缓存字段", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.OPENAI);

        // 同一 chunk 里带部分缓存字段，后续 chunk 再补一个 —— 累积应当是「合并」而不是「覆盖」
        collector.addEvent(
            JSON.stringify({
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    prompt_tokens_details: { cached_tokens: 30 },
                },
            }),
        );
        collector.addEvent(
            JSON.stringify({ usage: { prompt_tokens_details: { cache_write_tokens: 40 } } }),
        );

        expect(collector.getUsage()).toEqual({
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 40 },
        });
    });

    it("OpenAI：没有 usage 的 chunk 不把 hasUsage 置真", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.OPENAI);

        collector.addEvent(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));

        expect(collector.getUsage()).toBeNull();
    });

    it("Anthropic：从 message_start.message.usage 与 message_delta.usage 两处累积", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.ANTHROPIC);

        // message_start：输入侧 token（含缓存读/写）
        collector.addEvent(
            JSON.stringify({
                type: "message_start",
                message: {
                    usage: {
                        input_tokens: 50,
                        cache_read_input_tokens: 10,
                        cache_creation_input_tokens: 5,
                    },
                },
            }),
        );
        // message_delta：只有输出侧 token
        collector.addEvent(JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } }));

        expect(collector.getUsage()).toEqual({
            input_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
            output_tokens: 7,
        });
    });

    it("Anthropic：usage 既不在顶层也不在 message 里时不累积", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.ANTHROPIC);

        collector.addEvent(JSON.stringify({ type: "content_block_delta", delta: { text: "x" } }));

        expect(collector.getUsage()).toBeNull();
    });

    it("Responses：从 response.completed.response.usage 累积，并合并 input_tokens_details", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.RESPONSES);

        collector.addEvent(
            JSON.stringify({
                type: "response.created",
                response: { status: "in_progress" },
            }),
        );
        expect(collector.getUsage()).toBeNull();

        collector.addEvent(
            JSON.stringify({
                type: "response.completed",
                response: {
                    usage: {
                        input_tokens: 80,
                        output_tokens: 12,
                        input_tokens_details: { cached_tokens: 25 },
                    },
                },
            }),
        );

        expect(collector.getUsage()).toEqual({
            input_tokens: 80,
            output_tokens: 12,
            input_tokens_details: { cached_tokens: 25 },
        });
    });

    it("Responses：input_tokens_details 跨事件合并，后到的 cached_tokens 覆盖先到的", () => {
        const collector = new UpstreamUsageCollector(ApiFormat.RESPONSES);

        collector.addEvent(
            JSON.stringify({
                response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 } } },
            }),
        );
        // 上游后一个事件给出更完整的缓存读口径：合并后应以新值为准，且不影响已记的 input_tokens
        collector.addEvent(
            JSON.stringify({
                response: { usage: { input_tokens_details: { cached_tokens: 5 } } },
            }),
        );

        expect(collector.getUsage()).toEqual({
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 5 },
        });
    });
});
