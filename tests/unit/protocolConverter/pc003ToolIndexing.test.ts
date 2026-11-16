/**
 * PC-003-A：Chat(OpenAI) 流 → Anthropic 客户端，交错工具参数不得串块
 * PC-003-B：Responses 流 → Chat 客户端，工具下标不得沿用 output_index
 *
 * 改动前的实收（基线 5bf767d）：
 * - A：文档 4 步 delta 跑出来 block0=`{"a":`、block1=`{"b":1}2}`
 * - B：reasoning(0)→message(1)→function_call(output_index=2) 时 Chat 侧全是 index=2，
 *      累积后 tool_calls 3 项、前两项是 `{"function":{"arguments":""}}` 空壳
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import type { AnthropicToOpenAIConverter } from "../../../src/util/protocolConverter/AnthropicToOpenAIConverter";
import type { OpenAIToResponsesConverter } from "../../../src/util/protocolConverter/OpenAIToResponsesConverter";
import { OpenAIChatAccumulator } from "../../../src/util/accumulator/openaiChatAccumulator";
import { AnthropicAccumulator } from "../../../src/util/accumulator/anthropicAccumulator";
import { ApiFormat } from "../../../src/constants";
import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";

// ============================================================
// 公共断言器：按官方 SDK 的解析方式重放 Anthropic 事件流
// ============================================================

interface ParsedBlock {
    index: number;
    type: string;
    id?: string;
    name?: string;
    /** 该块收到的 input_json_delta 拼接结果 */
    json: string;
    /** 该块收到 delta 的条数 */
    deltas: number;
    stops: number;
}

/**
 * - 块 index 必须单调 0..n-1（客户端按 index 反查，插队会错位）
 * - 同一时刻只能有一个块处于「已 start、未 stop」
 * - 块收口后不得再收到任何 delta（关键：交错片段的回归防线）
 */
function replayAnthropicEvents(events: ProtocolStreamEvent[]) {
    const blocks: ParsedBlock[] = [];
    const order: number[] = [];
    const problems: string[] = [];
    const open = new Set<number>();
    const closed = new Set<number>();

    for (const e of events) {
        const d = JSON.parse(e.data as string);
        if (d.type === "content_block_start") {
            if (d.index !== blocks.length) {
                problems.push(`块 index 不连续：期望 ${blocks.length}，实际 ${d.index}`);
            }
            if (open.size > 0) {
                problems.push(`还有块未收口 index=${[...open].join(",")} 就开了 index=${d.index}`);
            }
            const b: ParsedBlock = {
                index: d.index,
                type: d.content_block.type,
                id: d.content_block.id,
                name: d.content_block.name,
                json: "",
                deltas: 0,
                stops: 0,
            };
            blocks[d.index] = b;
            order.push(d.index);
            open.add(d.index);
        } else if (d.type === "content_block_delta") {
            const b = blocks[d.index];
            if (!b) {
                problems.push(`delta 指向不存在的块 index=${d.index}`);
                continue;
            }
            if (closed.has(d.index)) problems.push(`块 index=${d.index} 已收口还在发 delta`);
            b.deltas += 1;
            if (d.delta.type === "input_json_delta") b.json += d.delta.partial_json;
        } else if (d.type === "content_block_stop") {
            const b = blocks[d.index];
            if (!b) {
                problems.push(`stop 指向不存在的块 index=${d.index}`);
                continue;
            }
            if (closed.has(d.index)) problems.push(`重复收口 index=${d.index}`);
            b.stops += 1;
            closed.add(d.index);
            open.delete(d.index);
        } else if (d.type === "message_delta" || d.type === "message_stop") {
            if (open.size > 0) problems.push(`${d.type} 之前仍有块未收口 index=${[...open].join(",")}`);
        }
    }

    return { blocks, order, problems };
}

// ============================================================
// PC-003-A
// ============================================================

describe("PC-003-A Chat→Anthropic 交错工具参数", () => {
    let converter: AnthropicToOpenAIConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(
            ApiFormat.ANTHROPIC,
            ApiFormat.OPENAI,
            "gpt-test",
        ) as AnthropicToOpenAIConverter;
    });

    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-test",
            choices: [{ index: 0, delta, finish_reason: finish }],
        });

    /** 工具增量帧：`id`/`name` 只在首帧给，续传帧只带 index（文档里的上游行为） */
    const toolFrame = (
        index: number,
        opts: { id?: string; name?: string; args?: string } = {},
    ) =>
        chunk({
            tool_calls: [
                {
                    index,
                    ...(opts.id ? { id: opts.id } : {}),
                    ...(opts.name
                        ? { type: "function", function: { name: opts.name, arguments: opts.args ?? "" } }
                        : { function: { arguments: opts.args ?? "" } }),
                },
            ],
        });

    const run = (frames: string[], finishReason = "tool_calls") => {
        const events: ProtocolStreamEvent[] = [
            ...converter.convertStreamEvent(chunk({ role: "assistant" })),
            ...frames.flatMap((f) => converter.convertStreamEvent(f)),
            ...converter.convertStreamEvent(chunk({}, finishReason)),
            ...converter.convertStreamEvent("[DONE]"),
            ...converter.onUpstreamEnd(),
        ];
        return { events, ...replayAnthropicEvents(events) };
    };

    it("文档 4 步交错 delta（续传不带 id）：两工具参数各归各块、每块只收口一次", () => {
        const { blocks, problems } = run([
            toolFrame(0, { id: "call_a", name: "A", args: '{"a":' }),
            toolFrame(1, { id: "call_b", name: "B", args: '{"b":' }),
            toolFrame(0, { args: "1}" }),
            toolFrame(1, { args: "2}" }),
        ]);

        expect(problems).toEqual([]);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toMatchObject({ type: "tool_use", id: "call_a", name: "A" });
        expect(blocks[1]).toMatchObject({ type: "tool_use", id: "call_b", name: "B" });
        expect(JSON.parse(blocks[0].json)).toEqual({ a: 1 });
        expect(JSON.parse(blocks[1].json)).toEqual({ b: 2 });
        // 每块只收口一次（收口后不再发增量）
        expect(blocks.map((b) => b.stops)).toEqual([1, 1]);
    });

    it("同一 chunk 两个工具后交错续传：参数不串块", () => {
        const { blocks, problems } = run([
            chunk({
                tool_calls: [
                    { index: 0, id: "call_a", type: "function", function: { name: "A", arguments: '{"a":' } },
                    { index: 1, id: "call_b", type: "function", function: { name: "B", arguments: '{"b":' } },
                ],
            }),
            toolFrame(1, { args: "2}" }),
            toolFrame(0, { args: "1}" }),
        ]);

        expect(problems).toEqual([]);
        expect(JSON.parse(blocks[0].json)).toEqual({ a: 1 });
        expect(JSON.parse(blocks[1].json)).toEqual({ b: 2 });
    });

    it("工具先后结束：先收口的块不再收到后到的增量", () => {
        const { blocks, events, problems } = run([
            toolFrame(0, { id: "call_a", name: "A", args: '{"a":1}' }),
            toolFrame(1, { id: "call_b", name: "B", args: '{"b":2}' }),
        ]);

        expect(problems).toEqual([]);
        // 块 0 的 stop 必须早于块 1 的 start（顺序块生命周期）
        const types = events.map((e) => JSON.parse(e.data as string)).filter((d) => d.type === "content_block_start" || d.type === "content_block_stop");
        expect(types.map((d) => `${d.type}@${d.index}`)).toEqual([
            "content_block_start@0",
            "content_block_stop@0",
            "content_block_start@1",
            "content_block_stop@1",
        ]);
        expect(JSON.parse(blocks[0].json)).toEqual({ a: 1 });
        expect(JSON.parse(blocks[1].json)).toEqual({ b: 2 });
    });

    it("文本之后开始工具：块 index 顺延，文本块先收口", () => {
        const { blocks, problems } = run(
            [
                chunk({ content: "先查两件事" }),
                toolFrame(0, { id: "call_a", name: "A", args: '{"a":' }),
                toolFrame(1, { id: "call_b", name: "B", args: '{"b":' }),
                toolFrame(0, { args: "1}" }),
                toolFrame(1, { args: "2}" }),
            ],
            "tool_calls",
        );

        expect(problems).toEqual([]);
        expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
        expect(blocks.map((b) => b.index)).toEqual([0, 1, 2]);
        expect(JSON.parse(blocks[1].json)).toEqual({ a: 1 });
        expect(JSON.parse(blocks[2].json)).toEqual({ b: 2 });
    });

    it("反向判据：工具索引不连续/乱序（7 与 3 交错）时仍按发现顺序分块且不串块", () => {
        const { blocks, problems } = run([
            toolFrame(7, { id: "call_seven", name: "S", args: '{"s":' }),
            toolFrame(3, { id: "call_three", name: "T", args: '{"t":' }),
            toolFrame(3, { args: '["x",' }),
            toolFrame(7, { args: "7}" }),
            toolFrame(3, { args: "1]}" }),
            toolFrame(7, { args: "" }),
        ]);

        expect(problems).toEqual([]);
        // 块 index 只跟「第几个被看到的工具」有关，与 Chat 的 index 数值无关
        expect(blocks.map((b) => b.index)).toEqual([0, 1]);
        expect(blocks.map((b) => b.id)).toEqual(["call_seven", "call_three"]);
        expect(JSON.parse(blocks[0].json)).toEqual({ s: 7 });
        expect(JSON.parse(blocks[1].json)).toEqual({ t: ["x", 1] });
        expect(blocks.map((b) => b.stops)).toEqual([1, 1]);
    });

    it("反向判据：三个工具全部交错，参数仍逐块完整", () => {
        const { blocks, problems } = run([
            toolFrame(0, { id: "c0", name: "T0", args: '{"v":' }),
            toolFrame(1, { id: "c1", name: "T1", args: '{"v":' }),
            toolFrame(2, { id: "c2", name: "T2", args: '{"v":' }),
            toolFrame(1, { args: "1" }),
            toolFrame(2, { args: "2" }),
            toolFrame(1, { args: "}" }),
            toolFrame(0, { args: "0}" }),
            toolFrame(2, { args: "}" }),
        ]);

        expect(problems).toEqual([]);
        expect(blocks.map((b) => b.id)).toEqual(["c0", "c1", "c2"]);
        expect(blocks.map((b) => JSON.parse(b.json))).toEqual([{ v: 0 }, { v: 1 }, { v: 2 }]);
    });

    it("转换器 → Anthropic 累加器联跑：交错参数在累积结果里也各归各工具", () => {
        const acc = new AnthropicAccumulator();
        for (const e of run([
            toolFrame(0, { id: "call_a", name: "A", args: '{"a":' }),
            toolFrame(1, { id: "call_b", name: "B", args: '{"b":' }),
            toolFrame(0, { args: "1}" }),
            toolFrame(1, { args: "2}" }),
        ]).events) {
            acc.addEvent(e);
        }

        const toolUses = (acc.getResponse() as unknown as {
            choices: Array<{ message: { tool_use?: Array<{ id: string; name: string; input?: unknown }> } }>;
        }).choices[0].message.tool_use ?? [];

        expect(toolUses).toHaveLength(2);
        expect(toolUses.map((t) => t.id)).toEqual(["call_a", "call_b"]);
        expect(toolUses.map((t) => t.name)).toEqual(["A", "B"]);
        expect(toolUses.map((t) => t.input)).toEqual([{ a: 1 }, { b: 2 }]);
    });
});

// ============================================================
// PC-003-B
// ============================================================

describe("PC-003-B Responses→Chat 工具下标", () => {
    let converter: OpenAIToResponsesConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(
            ApiFormat.OPENAI,
            ApiFormat.RESPONSES,
            "gpt-test",
        ) as OpenAIToResponsesConverter;
    });

    const ev = (o: Record<string, unknown>) => JSON.stringify(o);

    /** 跑一遍转换 + Chat 累积，返回 Chat 侧工具增量序列与最终累积结果 */
    const run = (frames: string[]) => {
        const acc = new OpenAIChatAccumulator();
        const toolDeltas: Array<{ index: number; id?: string; name?: string; args: string }> = [];
        for (const f of frames) {
            for (const e of converter.convertStreamEvent(f)) {
                if (e.data === "[DONE]") continue;
                const d = JSON.parse(e.data as string);
                const tcs = d.choices?.[0]?.delta?.tool_calls as
                    | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
                    | undefined;
                if (tcs) {
                    for (const tc of tcs) {
                        toolDeltas.push({
                            index: tc.index,
                            id: tc.id,
                            name: tc.function?.name,
                            args: tc.function?.arguments ?? "",
                        });
                    }
                }
                acc.addEvent(e);
            }
        }
        const accumulated = acc.getResponse() as unknown as {
            choices: Array<{ message: { tool_calls?: Array<{ id?: string; function: { name?: string; arguments: string } }> } }>;
        };
        return { toolDeltas, accumulated, toolCalls: accumulated.choices[0].message.tool_calls ?? [] };
    };

    const added = (outputIndex: number, item: Record<string, unknown>) =>
        ev({ type: "response.output_item.added", output_index: outputIndex, item });
    const argsDelta = (outputIndex: number, itemId: string, delta: string) =>
        ev({ type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: itemId, delta });
    const completed = ev({
        type: "response.completed",
        response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    });

    it("reasoning + message 之后的第一个工具：Chat index 从 0 起，无空壳工具项", () => {
        const { toolDeltas, toolCalls } = run([
            ev({ type: "response.created", response: { id: "resp_1", model: "gpt-test" } }),
            added(0, { type: "reasoning", id: "rs_1" }),
            ev({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_1", delta: "想一下" }),
            added(1, { type: "message", id: "msg_1" }),
            ev({ type: "response.output_text.delta", output_index: 1, item_id: "msg_1", delta: "你好" }),
            added(2, { type: "function_call", id: "fc_1", call_id: "call_a", name: "A" }),
            argsDelta(2, "fc_1", '{"a":'),
            argsDelta(2, "fc_1", "1}"),
            completed,
        ]);

        expect(toolDeltas.map((d) => d.index)).toEqual([0, 0, 0]);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].id).toBe("call_a");
        expect(toolCalls[0].function.name).toBe("A");
        expect(toolCalls[0].function.arguments).toBe('{"a":1}');
        // 没有任何空壳（既无 id 也无 name 的占位项）
        expect(toolCalls.filter((t) => !t.id && !t.function?.name)).toEqual([]);
    });

    it("多个工具：Chat index 0..n-1 连续，数量等于工具数", () => {
        const { toolDeltas, toolCalls } = run([
            ev({ type: "response.created", response: { id: "resp_1", model: "gpt-test" } }),
            added(0, { type: "reasoning", id: "rs_1" }),
            added(2, { type: "function_call", id: "fc_1", call_id: "call_a", name: "A" }),
            argsDelta(2, "fc_1", '{"a":1}'),
            added(3, { type: "message", id: "msg_1" }),
            ev({ type: "response.output_text.delta", output_index: 3, item_id: "msg_1", delta: "ok" }),
            added(4, { type: "function_call", id: "fc_2", call_id: "call_b", name: "B" }),
            argsDelta(4, "fc_2", '{"b":'),
            argsDelta(4, "fc_2", "2}"),
            completed,
        ]);

        const indices = [...new Set(toolDeltas.map((d) => d.index))].sort((a, b) => a - b);
        expect(indices).toEqual([0, 1]);
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls.map((t) => t.id)).toEqual(["call_a", "call_b"]);
        expect(toolCalls.map((t) => t.function.arguments)).toEqual(['{"a":1}', '{"b":2}']);
        expect(toolCalls.filter((t) => !t.id && !t.function?.name)).toEqual([]);
    });

    it("反向判据：工具参数增量与 reasoning/text 交错，工具下标不漂移", () => {
        const { toolDeltas, toolCalls } = run([
            ev({ type: "response.created", response: { id: "resp_1", model: "gpt-test" } }),
            added(0, { type: "function_call", id: "fc_1", call_id: "call_a", name: "A" }),
            argsDelta(0, "fc_1", '{"a":'),
            // 中间穿插别的输出类型的增量，工具下标必须保持 0
            ev({ type: "response.reasoning_summary_text.delta", output_index: 1, item_id: "rs_1", delta: "插一句" }),
            argsDelta(0, "fc_1", "1}"),
            added(2, { type: "function_call", id: "fc_2", call_id: "call_b", name: "B" }),
            argsDelta(2, "fc_2", "{}"),
            completed,
        ]);

        const byTool = new Map<number, string>();
        for (const d of toolDeltas) byTool.set(d.index, (byTool.get(d.index) ?? "") + d.args);
        expect([...byTool.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
        expect([...byTool.values()]).toEqual(['{"a":1}', "{}"]);
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls.map((t) => t.id)).toEqual(["call_a", "call_b"]);
    });

    it("同一响应内先文字后工具，工具下标仍从 0 起（不随 output_index 漂移）", () => {
        const { toolDeltas, toolCalls } = run([
            ev({ type: "response.created", response: { id: "resp_1", model: "gpt-test" } }),
            added(0, { type: "message", id: "msg_1" }),
            ev({ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "文字" }),
            added(1, { type: "function_call", id: "fc_1", call_id: "call_z", name: "Z" }),
            argsDelta(1, "fc_1", "{}"),
            completed,
        ]);

        expect(toolDeltas.every((d) => d.index === 0)).toBe(true);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].id).toBe("call_z");
    });
});
