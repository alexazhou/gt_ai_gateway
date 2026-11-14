import { describe, it, expect } from "vitest";
import openaiChatAccumulator from "../../../../src/util/accumulator/openaiChatAccumulator";
import anthropicAccumulator from "../../../../src/util/accumulator/anthropicAccumulator";
import type { ProtocolStreamEvent } from "../../../../src/util/protocol/commonTypes";

/**
 * 累积器的收尾与计数语义。
 *
 * 为什么值得单独锁：累积器的 `isCompleted()` 直接决定「这次请求按成功还是失败结算」，
 * 而「上游省略 `[DONE]` 直接关连接」是真实存在的行为。判错方向 = 要么把成功算失败（漏计费），
 * 要么把截断算成功（多计费）。
 */

const evt = (payload: unknown, event?: string): ProtocolStreamEvent => ({
    data: typeof payload === "string" ? payload : JSON.stringify(payload),
    event,
});

describe("openaiChatAccumulator", () => {
    it("未收到 finish_reason 就 EOF → 不算完成（真截断不能记成功）", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();

        acc.addEvent(evt({ choices: [{ index: 0, delta: { content: "半句" } }] }));
        acc.onUpstreamEnd();

        expect(acc.isCompleted()).toBe(false);
    });

    it("已收到 finish_reason 但上游没发 [DONE] → EOF 收尾记完成", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();

        acc.addEvent(
            evt({ choices: [{ index: 0, delta: { content: "完整" }, finish_reason: null }] }),
        );
        acc.addEvent(evt({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        acc.onUpstreamEnd();

        expect(acc.isCompleted()).toBe(true);
    });

    it("choice.index 跳号时按下标补位，不把内容写错 choice", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();

        acc.addEvent(evt({ choices: [{ index: 2, delta: { content: "第三个" } }] }));

        const resp = acc.getResponse() as { choices: { index: number; message: { content: string } }[] };
        expect(resp.choices).toHaveLength(3);
        expect(resp.choices[0].message.content).toBe("");
        expect(resp.choices[2].index).toBe(2);
        expect(resp.choices[2].message.content).toBe("第三个");
    });

    it("getText() 返回首条 choice 的正文；无 choices 时返回空串", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        expect(acc.getText()).toBe("");

        acc.addEvent(evt({ choices: [{ index: 0, delta: { content: "你好" } }] }));

        expect(acc.getText()).toBe("你好");
    });

    it("首 token 时间：未输出时为 null，首个 delta 后为时间戳", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();

        expect(acc.getFirstTokenTime()).toBeNull();

        acc.addEvent(evt({ choices: [{ index: 0, delta: { content: "x" } }] }));

        expect(typeof acc.getFirstTokenTime()).toBe("number");
    });
});

describe("anthropicAccumulator", () => {
    it("首个 thinking delta 时 thinking 字段初始化为串（不是 undefined 拼接出 NaN 文本）", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();

        acc.addEvent(
            evt(
                { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "想一下" } },
                "content_block_delta",
            ),
        );

        const resp = acc.getResponse() as { choices: { message: { thinking?: string } }[] };
        expect(resp.choices[0].message.thinking).toBe("想一下");
    });

    it("getText() 返回正文文本", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();
        expect(acc.getText()).toBe("");

        acc.addEvent(
            evt(
                { type: "content_block_delta", delta: { type: "text_delta", text: "答案" } },
                "content_block_delta",
            ),
        );

        expect(acc.getText()).toBe("答案");
    });
});
