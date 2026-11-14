import { describe, it, expect } from "vitest";
import { AnthropicToResponsesConverter } from "../../../src/util/protocolConverter/AnthropicToResponsesConverter";
import { ResponsesToOpenAIConverter } from "../../../src/util/protocolConverter/ResponsesToOpenAIConverter";
import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";

/**
 * 流式「块（block / output_item）」的开合生命周期。
 *
 * 漏发 `*_start` / `*_stop` / `*_done` 不会报错，但客户端会**一直等收尾**（SDK 挂住），
 * 或者把 reasoning 与正文塞进同一个块。所以断言的是块的**序号、类型与内容归属**。
 */

const data = (e: ProtocolStreamEvent): any => JSON.parse(e.data);

describe("AnthropicToResponsesConverter：上游块起始事件", () => {
    const c = (): AnthropicToResponsesConverter => new AnthropicToResponsesConverter("gpt-4");

    it("response.content_part.added → content_block_start(text)，且沿用上游 content_index", () => {
        const conv = c();
        conv.convertStreamEvent(
            JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-4" } }),
            "response.created",
        );

        const out = conv.convertStreamEvent(
            JSON.stringify({
                type: "response.content_part.added",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                part: { type: "output_text", text: "" },
            }),
            "response.content_part.added",
        );

        const start = out.map(data).find((d) => d.type === "content_block_start");
        expect(start).toEqual({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        });
    });

    it("response.reasoning_summary_part.added → content_block_start(thinking)，与正文分开编号", () => {
        const conv = c();
        conv.convertStreamEvent(
            JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-4" } }),
            "response.created",
        );
        conv.convertStreamEvent(
            JSON.stringify({
                type: "response.content_part.added",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                part: { type: "output_text", text: "" },
            }),
            "response.content_part.added",
        );

        const out = conv.convertStreamEvent(
            JSON.stringify({
                type: "response.reasoning_summary_part.added",
                output_index: 1,
                summary_index: 0,
                item_id: "rs_1",
                part: { type: "summary_text", text: "" },
            }),
            "response.reasoning_summary_part.added",
        );

        const start = out.map(data).find((d) => d.type === "content_block_start");
        expect(start.index).toBe(1);
        expect(start.content_block.type).toBe("thinking");
    });

    it("response.output_item.done → content_block_stop（收尾已开块，客户端不再等）", () => {
        const conv = c();
        conv.convertStreamEvent(
            JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-4" } }),
            "response.created",
        );
        conv.convertStreamEvent(
            JSON.stringify({
                type: "response.content_part.added",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                part: { type: "output_text", text: "" },
            }),
            "response.content_part.added",
        );

        const out = conv.convertStreamEvent(
            JSON.stringify({
                type: "response.output_item.done",
                output_index: 0,
                item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "hi" }] },
            }),
            "response.output_item.done",
        );

        expect(out.map(data).map((d) => d.type)).toContain("content_block_stop");
    });

    it("assistant 消息 content 为字符串时转成 message input（Anthropic 允许 string content）", () => {
        const result = c().convertRequest({
            model: "gpt-4",
            max_tokens: 16,
            messages: [
                { role: "user", content: "hi" },
                { role: "assistant", content: "这是上一次的回答" },
            ],
        } as any);

        const assistant = (result.input as any[]).find(
            (i) => i.type === "message" && i.role === "assistant",
        );
        expect(assistant.content).toEqual([{ type: "output_text", text: "这是上一次的回答" }]);
    });
});

describe("ResponsesToOpenAIConverter：reasoning / function_call 的收尾事件", () => {
    it("reasoning 流收尾：summary_text.done + part.done + output_item.done(带汇总文本) + completed", () => {
        const c = new ResponsesToOpenAIConverter("gpt-4");
        const evts: ProtocolStreamEvent[] = [];

        evts.push(
            ...c.convertStreamEvent(
                JSON.stringify({
                    id: "chatcmpl-1",
                    model: "gpt-4",
                    choices: [{ index: 0, delta: { reasoning_content: "想" } }],
                }),
                undefined,
            ),
        );
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

        // 上游给了 finish_reason 但没发 [DONE]：收尾靠 onUpstreamEnd 补
        evts.push(...c.onUpstreamEnd());

        const parsed = evts.map(data).filter(Boolean);
        const types = parsed.map((d) => d.type);
        const reasonDone = parsed.find((d) => d.type === "response.reasoning_summary_text.done");
        expect(reasonDone.text).toBe("想");
        expect(types).toContain("response.reasoning_summary_text.done");
        expect(types).toContain("response.reasoning_summary_part.done");

        const itemDone = parsed
            .filter((d) => d.type === "response.output_item.done")
            .map((d) => d.item)
            .find((i: any) => i?.type === "reasoning");
        expect(itemDone.summary).toEqual([{ type: "summary_text", text: "想" }]);

        expect(types[types.length - 1]).toBe("response.completed");
    });

    it("tool_call 流收尾：arguments.done + output_item.done(保留 arguments 与 call_id)", () => {
        const c = new ResponsesToOpenAIConverter("gpt-4");
        const evts: ProtocolStreamEvent[] = [];

        evts.push(
            ...c.convertStreamEvent(
                JSON.stringify({
                    id: "c2",
                    model: "gpt-4",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_1",
                                        type: "function",
                                        function: { name: "get_weather", arguments: '{"city":"SH"}' },
                                    },
                                ],
                            },
                        },
                    ],
                }),
                undefined,
            ),
        );
        evts.push(
            ...c.convertStreamEvent(
                JSON.stringify({
                    id: "c2",
                    model: "gpt-4",
                    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                }),
                undefined,
            ),
        );

        const parsed = evts.map(data).filter(Boolean);
        const argsDone = parsed.find((d) => d.type === "response.function_call_arguments.done");
        expect(argsDone.arguments).toBe('{"city":"SH"}');

        const itemDone = parsed
            .filter((d) => d.type === "response.output_item.done")
            .map((d) => d.item)
            .find((i: any) => i?.type === "function_call");
        expect(itemDone).toMatchObject({
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"SH"}',
        });
    });
});
