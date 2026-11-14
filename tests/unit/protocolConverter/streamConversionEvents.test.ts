import { describe, it, expect } from "vitest";
import { OpenAIToResponsesConverter } from "../../../src/util/protocolConverter/OpenAIToResponsesConverter";
import { ResponsesToOpenAIConverter } from "../../../src/util/protocolConverter/ResponsesToOpenAIConverter";
import { AnthropicToResponsesConverter } from "../../../src/util/protocolConverter/AnthropicToResponsesConverter";
import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";

/**
 * 流式协议转换：**上游事件 → 客户端事件** 的逐事件映射。
 *
 * 这一层最容易「看起来跑通、实际漏语义」——漏掉一个 `*.done` 事件不会报错，
 * 但客户端会拿不到收尾、SDK 会一直等到超时。所以断言的是**事件类型序列与关键字段**。
 */

// 流末尾会有 `[DONE]` 这种非 JSON 载荷，解析失败时返回 null，避免断言里被它炸掉
const data = (e: ProtocolStreamEvent): any => {
    try {
        return JSON.parse(e.data);
    } catch {
        return null;
    }
};
const types = (evts: ProtocolStreamEvent[]): string[] => evts.map((e) => data(e).type);

describe("OpenAIToResponsesConverter：流式（Responses 上游事件 → OpenAI chunk）", () => {
    it("function_call 全生命周期：item.added → arguments.delta → completed(tool_calls)", () => {
        const c = new OpenAIToResponsesConverter("gpt-4");

        const added = c.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather" },
            }),
            "response.output_item.added",
        );
        const addedDelta = data(added[0]).choices[0].delta;
        expect(addedDelta.tool_calls?.[0]?.id).toBe("call_1");
        expect(addedDelta.tool_calls?.[0]?.function?.name).toBe("get_weather");

        const args = c.convertStreamEvent(
            JSON.stringify({
                type: "response.function_call_arguments.delta",
                output_index: 0,
                delta: '{"city":',
            }),
            "response.function_call_arguments.delta",
        );
        expect(data(args[0]).choices[0].delta.tool_calls?.[0]?.function?.arguments).toBe('{"city":');

        const completed = c.convertStreamEvent(
            JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } }),
            "response.completed",
        );
        const finished = completed
            .map(data)
            .filter((d) => d?.choices?.[0]?.finish_reason)
            .map((d) => d.choices[0].finish_reason);
        expect(finished).toContain("tool_calls");
        // 末尾必须给终止标记，否则客户端会一直等
        expect(completed[completed.length - 1].data).toBe("[DONE]");
    });

    it("reasoning 流：summary_text.delta → reasoning_content；done 不发 finish_reason；completed 收尾 stop", () => {
        const c = new OpenAIToResponsesConverter("gpt-4");

        const delta = c.convertStreamEvent(
            JSON.stringify({
                type: "response.reasoning_summary_text.delta",
                output_index: 0,
                delta: "先想一步",
            }),
            "response.reasoning_summary_text.delta",
        );
        expect(data(delta[0]).choices[0].delta.reasoning_content).toBe("先想一步");

        const done = c.convertStreamEvent(
            JSON.stringify({ type: "response.reasoning_summary_text.done", output_index: 0 }),
            "response.reasoning_summary_text.done",
        );
        expect(done.every((e) => data(e).choices?.[0]?.finish_reason == null)).toBe(true);

        const completed = c.convertStreamEvent(
            JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } }),
            "response.completed",
        );
        expect(completed.map(data).map((d) => d?.choices?.[0]?.finish_reason).filter(Boolean)).toContain("stop");
    });

    it("上游 error 事件原样透传（不吞成正常结束）", () => {
        const c = new OpenAIToResponsesConverter("gpt-4");
        const raw = JSON.stringify({ type: "error", code: "server_error", message: "boom" });

        const out = c.convertStreamEvent(raw, "error");

        expect(out).toHaveLength(1);
        expect(out[0].data).toBe(raw);
        expect(out[0].event).toBe("error");
    });
});

describe("ResponsesToOpenAIConverter：onUpstreamEnd 收尾事件", () => {
    it("消息流结束时补齐 output_text.done / content_part.done / output_item.done，并以 response.completed 结束", () => {
        const c = new ResponsesToOpenAIConverter("gpt-4");
        const evts: ProtocolStreamEvent[] = [];

        // 上游 OpenAI chunk：一段正常文本
        evts.push(
            ...c.convertStreamEvent(
                JSON.stringify({
                    id: "chatcmpl-1",
                    model: "gpt-4",
                    choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }],
                }),
                undefined,
            ),
        );
        // 上游给了 finish_reason，但**没发 `[DONE]` 就 EOF**（真实上游常见）→ 只能靠 onUpstreamEnd 补收尾
        evts.push(
            ...c.convertStreamEvent(
                JSON.stringify({
                    id: "chatcmpl-1",
                    model: "gpt-4",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                }),
                undefined,
            ),
        );
        evts.push(...c.onUpstreamEnd());

        const seq = types(evts);
        expect(seq).toContain("response.output_text.done");
        expect(seq).toContain("response.content_part.done");
        expect(seq).toContain("response.output_item.done");
        expect(seq[seq.length - 1]).toBe("response.completed");
    });
});

describe("AnthropicToResponsesConverter：上游 incomplete", () => {
    it("response.incomplete 且 reason 非 content_filter → stop_reason=max_tokens（不是 end_turn）", () => {
        const c = new AnthropicToResponsesConverter("gpt-4");

        c.convertStreamEvent(
            JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-4" } }),
            "response.created",
        );
        const out = c.convertStreamEvent(
            JSON.stringify({
                type: "response.incomplete",
                response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
            }),
            "response.incomplete",
        );

        const stopEvents = out
            .map((e) => data(e))
            .filter((d) => d.type === "message_delta" || d.stop_reason != null);
        expect(JSON.stringify(stopEvents)).toContain("max_tokens");
    });
});
