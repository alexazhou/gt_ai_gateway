/**
 * #296（协议批2）PC-009-A / PC-009-B / PC-009-D
 *
 * 三条都是「凭据在网关里被截断或丢弃」，判据一律落在**下一轮还能不能带上原凭据**上，
 * 只证明「输出里有字段」不算过。
 *
 * 改动前实收（基线 5bf767d，脚本 shared/gw-pc-009-cred/repro/repro.ts）：
 * - A：流式 reasoning 转换后 signature_delta 条数 = 0；累加器 signature=""；下一轮回去的
 *      reasoning 项只剩 summary，`encrypted_content` 丢失（非流式同一份数据却能恢复出 "cipher"）
 * - B：同一 thinking 块两段签名，封包解出 "part2"、下一轮请求的 signature 也是 "part2"
 * - D：`summary=[] + encrypted_content="opaque-cipher"` 的 reasoning 被整项丢弃，content 长度 0
 *
 * 契约边界（别扩权）：
 * - A 只保证「最后一个 summary part 对应的 thinking 块携带整项凭据」；一个 reasoning 项有多个
 *   summary part 时不逐块复制密文（否则下一轮会恢复出多份重复凭据）。
 * - B 只保证「同一 thinking 块的签名片段按到达顺序累积」；多 thinking 块时 `message.signature`
 *   留空、逐块取值看 `thinking_signatures`（一个字段表达不了多份互不相干的凭据，不伪造）。
 * - D 选的是「表示」路径（thinking 文本置空 + 封包签名带密文），不是「拒绝」。
 */
import { describe, it, expect } from "vitest";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ApiFormat } from "../../../src/constants";
import protocolConverterUtil from "../../../src/util/protocolConverter/protocolConverterUtil";
import { AnthropicAccumulator } from "../../../src/util/accumulator/anthropicAccumulator";
import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";

const MODEL = "gpt-test";
const j = (o: unknown) => JSON.stringify(o);

type AnyRecord = Record<string, any>;

// ────────────────────────────────────────────────────────────
// A / D 方向：客户端 Anthropic ← 上游 Responses
// ────────────────────────────────────────────────────────────

function anthropicClientConverter() {
    return ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES, MODEL) as any;
}

/** 把 Responses 流喂进转换器，返回事件 + 解析后的事件 */
function runStream(conv: any, frames: AnyRecord[]) {
    const events: ProtocolStreamEvent[] = [];
    for (const f of frames) events.push(...conv.convertStreamEvent(j(f)));
    const parsed = events
        .filter((e) => e.data !== "[DONE]")
        .map((e) => JSON.parse(e.data as string) as AnyRecord);
    return { events, parsed };
}

const signatureDeltas = (parsed: AnyRecord[]) =>
    parsed.filter((e) => e.type === "content_block_delta" && e.delta?.type === "signature_delta");

/** 用 Anthropic 客户端的方式攒出「下一轮要回传的历史」 */
function accumulate(events: ProtocolStreamEvent[]) {
    const acc = new AnthropicAccumulator();
    for (const e of events) acc.addEvent(e);
    return (acc.getResponse() as any).choices[0].message as {
        thinking?: string;
        signature?: string;
        thinking_signatures?: Record<number, string>;
    };
}

/** 下一轮：把 thinking 历史回传给「Anthropic 客户端 → Responses 上游」的请求转换器 */
function nextRoundReasoning(conv: any, content: AnyRecord[]) {
    const req = conv.convertRequest({
        model: MODEL,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content }],
    }) as AnyRecord;
    return (req.input as AnyRecord[]).filter((i) => i.type === "reasoning");
}

describe("PC-009-A 流式 reasoning 的恢复凭据", () => {
    /** 文档 §4.2 六步：reasoning 项的 done 帧带 summary 与 encrypted_content */
    const reasoningFrames = (opts: {
        id?: string;
        outputIndex?: number;
        text?: string;
        cipher?: string;
        withDoneCipher?: boolean;
        withCreated?: boolean;
    } = {}): AnyRecord[] => {
        const id = opts.id ?? "rs_0";
        const outputIndex = opts.outputIndex ?? 0;
        const text = opts.text ?? "think";
        const cipher = opts.cipher ?? "cipher";
        const withDoneCipher = opts.withDoneCipher ?? true;
        return [
            ...(opts.withCreated === false ? [] : [{ type: "response.created", response: { id: "resp_1", model: MODEL } }]),
            { type: "response.output_item.added", output_index: outputIndex, item: { id, type: "reasoning", summary: [] } },
            { type: "response.reasoning_summary_part.added", output_index: outputIndex, item_id: id, summary_index: 0 },
            { type: "response.reasoning_summary_text.delta", output_index: outputIndex, item_id: id, summary_index: 0, delta: text },
            {
                type: "response.output_item.done",
                output_index: outputIndex,
                item: {
                    id,
                    type: "reasoning",
                    summary: [{ type: "summary_text", text }],
                    ...(withDoneCipher ? { encrypted_content: cipher } : {}),
                },
            },
        ];
    };

    it("关闭块之前发 signature_delta，下一轮恢复出原 encrypted_content", () => {
        const conv = anthropicClientConverter();
        const { events, parsed } = runStream(conv, [
            ...reasoningFrames(),
            { type: "response.completed", response: { id: "resp_1", model: MODEL, status: "completed", output: [] } },
        ]);

        const sigs = signatureDeltas(parsed);
        expect(sigs).toHaveLength(1);
        // 顺序：signature_delta 必须在 content_block_stop 之前（否则客户端不会收进该块）
        const sigIdx = parsed.findIndex((e) => e.type === "content_block_delta" && e.delta?.type === "signature_delta");
        const stopIdx = parsed.findIndex((e) => e.type === "content_block_stop");
        expect(sigIdx).toBeGreaterThan(-1);
        expect(sigIdx).toBeLessThan(stopIdx);

        const message = accumulate(events);
        expect(message.thinking).toBe("think");
        expect(message.signature).toBeTruthy();

        const next = nextRoundReasoning(conv, [
            { type: "thinking", thinking: message.thinking, signature: message.signature },
        ]);
        expect(next).toHaveLength(1);
        expect(next[0].encrypted_content).toBe("cipher");
        expect(next[0].summary).toEqual([{ type: "summary_text", text: "think" }]);
    });

    it("与非流式路径一致：同一条 reasoning 项，两条路径恢复出同一个 encrypted_content", () => {
        const conv = anthropicClientConverter();
        const upstream = {
            id: "resp_1",
            model: MODEL,
            status: "completed",
            output: [{ id: "rs_0", type: "reasoning", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "cipher" }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        };
        const nonStream = conv.convertResponse(upstream) as AnyRecord;
        expect(nonStream.content).toHaveLength(1);
        const nonStreamThinking = nonStream.content[0];
        expect(nonStreamThinking.type).toBe("thinking");

        const { events } = runStream(conv, [
            ...reasoningFrames(),
            { type: "response.completed", response: { id: "resp_1", model: MODEL, status: "completed", output: upstream.output } },
        ]);
        const streamed = accumulate(events);

        const restoredNonStream = nextRoundReasoning(conv, [nonStreamThinking]);
        const restoredStream = nextRoundReasoning(conv, [
            { type: "thinking", thinking: streamed.thinking, signature: streamed.signature },
        ]);

        expect(restoredStream[0].encrypted_content).toBe("cipher");
        expect(restoredNonStream[0].encrypted_content).toBe(restoredStream[0].encrypted_content);
        expect(restoredNonStream[0].summary).toEqual(restoredStream[0].summary);
    });

    it("多个 reasoning 项：各自凭据各自恢复，不串", () => {
        const conv = anthropicClientConverter();
        const { events, parsed } = runStream(conv, [
            ...reasoningFrames({ id: "rs_0", outputIndex: 0, text: "first", cipher: "cipher-0" }),
            ...reasoningFrames({ id: "rs_1", outputIndex: 1, text: "second", cipher: "cipher-1", withCreated: false }),
            { type: "response.completed", response: { id: "resp_1", model: MODEL, status: "completed", output: [] } },
        ]);

        expect(signatureDeltas(parsed)).toHaveLength(2);

        const acc = new AnthropicAccumulator();
        for (const e of events) acc.addEvent(e);
        const message = (acc.getResponse() as any).choices[0].message;
        // 两个 thinking 块：逐块签名都在，消息级 signature 不伪造单值
        expect(Object.keys(message.thinking_signatures ?? {})).toHaveLength(2);
        expect(message.signature).toBe("");

        const perBlock = message.thinking_signatures as Record<number, string>;
        const next0 = nextRoundReasoning(conv, [{ type: "thinking", thinking: "first", signature: perBlock[0] }]);
        const next1 = nextRoundReasoning(conv, [{ type: "thinking", thinking: "second", signature: perBlock[1] }]);
        expect(next0[0].encrypted_content).toBe("cipher-0");
        expect(next1[0].encrypted_content).toBe("cipher-1");
    });

    it("一个 reasoning 项多个 summary part：只有最后一块带凭据，下一轮只有一份密文", () => {
        const conv = anthropicClientConverter();
        const { events, parsed } = runStream(conv, [
            { type: "response.created", response: { id: "resp_1", model: MODEL } },
            { type: "response.output_item.added", output_index: 0, item: { id: "rs_0", type: "reasoning", summary: [] } },
            { type: "response.reasoning_summary_part.added", output_index: 0, item_id: "rs_0", summary_index: 0 },
            { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_0", summary_index: 0, delta: "part-A" },
            { type: "response.reasoning_summary_part.added", output_index: 0, item_id: "rs_0", summary_index: 1 },
            { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_0", summary_index: 1, delta: "part-B" },
            {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                    id: "rs_0",
                    type: "reasoning",
                    summary: [
                        { type: "summary_text", text: "part-A" },
                        { type: "summary_text", text: "part-B" },
                    ],
                    encrypted_content: "cipher",
                },
            },
            { type: "response.completed", response: { id: "resp_1", model: MODEL, status: "completed", output: [] } },
        ]);

        const sigs = signatureDeltas(parsed);
        expect(sigs).toHaveLength(1);
        // 打在最后一块（summary_index=1 → 块 index 1）上
        expect(sigs[0].index).toBe(1);

        const history = [
            { type: "thinking", thinking: "part-A", signature: "" },
            { type: "thinking", thinking: "part-B", signature: sigs[0].delta.signature },
        ];
        const next = nextRoundReasoning(conv, history);
        const withCipher = next.filter((i) => i.encrypted_content);
        expect(withCipher).toHaveLength(1);
        expect(withCipher[0].encrypted_content).toBe("cipher");
    });

    it("completed 只是最终快照：不重复发签名", () => {
        const conv = anthropicClientConverter();
        const doneItem = {
            id: "rs_0",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "think" }],
            encrypted_content: "cipher",
        };
        const { parsed } = runStream(conv, [
            ...reasoningFrames(),
            {
                type: "response.completed",
                response: { id: "resp_1", model: MODEL, status: "completed", output: [doneItem] },
            },
            // 再补一帧带同一 output 的 completed，模拟上游重复快照
            {
                type: "response.completed",
                response: { id: "resp_1", model: MODEL, status: "completed", output: [doneItem] },
            },
        ]);

        expect(signatureDeltas(parsed)).toHaveLength(1);
    });

    it("上游没给 encrypted_content：不伪造签名（无从恢复）", () => {
        const conv = anthropicClientConverter();
        const { parsed } = runStream(conv, [
            ...reasoningFrames({ withDoneCipher: false }),
            { type: "response.completed", response: { id: "resp_1", model: MODEL, status: "completed", output: [] } },
        ]);
        expect(signatureDeltas(parsed)).toHaveLength(0);
    });
});

describe("PC-009-D 仅密文 reasoning 不静默丢弃", () => {
    const upstreamWith = (output: AnyRecord[]) => ({
        id: "resp_d",
        model: MODEL,
        status: "completed",
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    it("summary=[] + encrypted_content：给出可恢复表示（thinking 空文本 + 封包签名）", () => {
        const conv = anthropicClientConverter();
        const res = conv.convertResponse(upstreamWith([
            { id: "rs_empty", type: "reasoning", summary: [], encrypted_content: "opaque-cipher" },
        ])) as AnyRecord;

        expect(res.content).toHaveLength(1);
        expect(res.content[0].type).toBe("thinking");
        expect(res.content[0].thinking).toBe("");
        expect(res.content[0].signature).toBeTruthy();

        const next = nextRoundReasoning(conv, [res.content[0]]);
        expect(next).toHaveLength(1);
        expect(next[0].encrypted_content).toBe("opaque-cipher");
    });

    it("摘要字段缺失 + encrypted_content：同样可恢复", () => {
        const conv = anthropicClientConverter();
        const res = conv.convertResponse(upstreamWith([
            { id: "rs_no_summary", type: "reasoning", encrypted_content: "opaque-cipher-2" },
        ])) as AnyRecord;

        expect(res.content).toHaveLength(1);
        expect(res.content[0].type).toBe("thinking");
        const next = nextRoundReasoning(conv, [res.content[0]]);
        expect(next[0].encrypted_content).toBe("opaque-cipher-2");
    });

    it("有摘要且有密文：文本与凭据都保留", () => {
        const conv = anthropicClientConverter();
        const res = conv.convertResponse(upstreamWith([
            { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "cipher" },
        ])) as AnyRecord;

        expect(res.content[0]).toMatchObject({ type: "thinking", thinking: "think" });
        const next = nextRoundReasoning(conv, [res.content[0]]);
        expect(next[0].encrypted_content).toBe("cipher");
        expect(next[0].summary).toEqual([{ type: "summary_text", text: "think" }]);
    });

    it("有摘要但无密文：文本保留，不伪造签名", () => {
        const conv = anthropicClientConverter();
        const res = conv.convertResponse(upstreamWith([
            { id: "rs_2", type: "reasoning", summary: [{ type: "summary_text", text: "only-text" }] },
        ])) as AnyRecord;

        expect(res.content).toHaveLength(1);
        expect(res.content[0]).toMatchObject({ type: "thinking", thinking: "only-text" });
        expect(res.content[0].signature).toBe("");
    });

    it("仅密文 reasoning + 文本混合：两者都在，没有静默丢弃", () => {
        const conv = anthropicClientConverter();
        const res = conv.convertResponse(upstreamWith([
            { id: "rs_empty", type: "reasoning", summary: [], encrypted_content: "opaque-cipher" },
            { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        ])) as AnyRecord;

        expect(res.content.map((b: AnyRecord) => b.type)).toEqual(["thinking", "text"]);
        const next = nextRoundReasoning(conv, [res.content[0]]);
        expect(next[0].encrypted_content).toBe("opaque-cipher");
    });
});

// ────────────────────────────────────────────────────────────
// B 方向：客户端 Responses ← 上游 Anthropic
// ────────────────────────────────────────────────────────────

function responsesClientConverter() {
    return ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, MODEL) as any;
}

/** 一条 thinking 块 + 若干 signature 片段，走 Responses 客户端方向的转换器 */
function runThinkingStream(conv: any, signatureParts: string[]) {
    const frames: AnyRecord[] = [
        { type: "message_start", message: { id: "msg_1", model: MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
        ...signatureParts.map((signature) => ({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature },
        })),
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
    ];
    return runStream(conv, frames);
}

/** 让 Responses 客户端把 reasoning 项回传，看下一轮 Anthropic 请求里的签名 */
function nextRoundSignature(conv: any, reasoningItem: AnyRecord) {
    const req = conv.convertRequest({
        model: MODEL,
        input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
            reasoningItem,
        ],
    }) as AnyRecord;
    const blocks = (req.messages as AnyRecord[]).flatMap((m) =>
        Array.isArray(m.content) ? (m.content as AnyRecord[]) : [],
    );
    return blocks.find((b) => b.type === "thinking")?.signature;
}

describe("PC-009-B 分段 thinking 签名累积", () => {
    it("多段签名：最终封包与下一轮请求都是完整拼接值", () => {
        const conv = responsesClientConverter();
        const { parsed } = runThinkingStream(conv, ["part1", "part2"]);

        const finalReasoning = parsed
            .filter((e) => e.type === "response.output_item.done")
            .map((e) => e.item)
            .find((i: AnyRecord) => i.type === "reasoning");
        expect(finalReasoning).toBeTruthy();

        const unsealed = protocolConverterUtil.unsealThinkingSignature(finalReasoning.encrypted_content, "anthropic", MODEL);
        expect(unsealed?.signature).toBe("part1part2");
        expect(unsealed?.thinking).toBe("think");
        expect(nextRoundSignature(conv, finalReasoning)).toBe("part1part2");
    });

    it("单段签名不受影响（回归）", () => {
        const conv = responsesClientConverter();
        const { parsed } = runThinkingStream(conv, ["single-part"]);
        const finalReasoning = parsed
            .filter((e) => e.type === "response.output_item.done")
            .map((e) => e.item)
            .find((i: AnyRecord) => i.type === "reasoning");
        const unsealed = protocolConverterUtil.unsealThinkingSignature(finalReasoning.encrypted_content, "anthropic", MODEL);
        expect(unsealed?.signature).toBe("single-part");
    });

    it("空签名片段不影响累积", () => {
        const conv = responsesClientConverter();
        const { parsed } = runThinkingStream(conv, ["part1", "", "part2"]);
        const finalReasoning = parsed
            .filter((e) => e.type === "response.output_item.done")
            .map((e) => e.item)
            .find((i: AnyRecord) => i.type === "reasoning");
        const unsealed = protocolConverterUtil.unsealThinkingSignature(finalReasoning.encrypted_content, "anthropic", MODEL);
        expect(unsealed?.signature).toBe("part1part2");
    });

    it("原生 Anthropic 累加器：同一块多段拼成完整签名", () => {
        const acc = new AnthropicAccumulator();
        const events: AnyRecord[] = [
            { event: "message_start", data: j({ type: "message_start", message: { id: "msg_1", model: MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } } }) },
            { event: "content_block_start", data: j({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "part1" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "part2" } }) },
            { event: "content_block_stop", data: j({ type: "content_block_stop", index: 0 }) },
            { event: "message_stop", data: j({ type: "message_stop" }) },
        ];
        for (const e of events) acc.addEvent(e as any);

        const message = (acc.getResponse() as any).choices[0].message;
        expect(message.thinking).toBe("think");
        expect(message.signature).toBe("part1part2");
        expect(message.thinking_signatures).toEqual({ 0: "part1part2" });
    });

    it("原生 Anthropic 累加器：多个 thinking 块各自归属，不混成一条", () => {
        const acc = new AnthropicAccumulator();
        const events: AnyRecord[] = [
            { event: "message_start", data: j({ type: "message_start", message: { id: "msg_2", model: MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } } }) },
            { event: "content_block_start", data: j({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "A" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "a1" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "a2" } }) },
            { event: "content_block_stop", data: j({ type: "content_block_stop", index: 0 }) },
            { event: "content_block_start", data: j({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "B" } }) },
            { event: "content_block_delta", data: j({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "b1" } }) },
            { event: "content_block_stop", data: j({ type: "content_block_stop", index: 1 }) },
            { event: "message_stop", data: j({ type: "message_stop" }) },
        ];
        for (const e of events) acc.addEvent(e as any);

        const message = (acc.getResponse() as any).choices[0].message;
        expect(message.thinking_signatures).toEqual({ 0: "a1a2", 1: "b1" });
        // 一个字段表达不了两份互不相干的凭据：不伪造
        expect(message.signature).toBe("");
    });

    it("两个 thinking 块各自多段：两个 reasoning 项各自封包，不串", () => {
        const conv = responsesClientConverter();
        const { parsed } = runStream(conv, [
            { type: "message_start", message: { id: "msg_3", model: MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "A" } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "a1" } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "a2" } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "B" } },
            { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "b1" } },
            { type: "content_block_stop", index: 1 },
            { type: "message_stop" },
        ]);

        const reasonings = parsed
            .filter((e) => e.type === "response.output_item.done")
            .map((e) => e.item)
            .filter((i: AnyRecord) => i.type === "reasoning");
        expect(reasonings).toHaveLength(2);

        const unsealed = reasonings.map((i: AnyRecord) =>
            protocolConverterUtil.unsealThinkingSignature(i.encrypted_content, "anthropic", MODEL),
        );
        expect(unsealed.map((u) => u?.signature)).toEqual(["a1a2", "b1"]);
        expect(unsealed.map((u) => u?.thinking)).toEqual(["A", "B"]);
    });
});
