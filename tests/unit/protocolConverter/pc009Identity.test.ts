/**
 * #297（协议批3）PC-009-C / §4.6 / §4.7
 *
 * 三条都围绕同一个字段：**响应里的 `model` 到底是谁的名字**。
 * 网关对客户端承诺「你请求了哪个模型，响应里就看到哪个模型」；上游是别家的名字（`actual-version`），
 * 一旦上游名漏到客户端可见的地方，会同时坏三件事：
 * 1. §4.7：客户端看到的 `model` 不是它请求的（多轮 SDK 会按 model 做后续分支）；
 * 2. PC-009-C：thinking 恢复凭据「封包时按上游名绑、解封时按客户端名查」，别名路由下合法回放被
 *    网关自己判成不兼容（400）；
 * 3. §4.6：同一个 reasoning 项在三处（added / done / completed）用不同表示描述同一份凭据。
 *
 * 改前实收（基线 `a78b973f`，脚本 `tmp_pc297/repro.ts`）：
 * - PC-009-C：别名往返 → 400 `Incompatible or unverified reasoning encrypted_content…`，
 *   `failed_code=undefined`；不兼容模型 400（仅因为名字碰巧不等，无明确码）；不兼容来源静默通过（无来源绑定）
 * - §4.7：非流式 `model="actual-version"`；上游改名 ⇒ 跟着变成上游新名；流式 `completed.model="actual-version"`
 *   且 `created` 整帧没有 `model`
 * - §4.6：`output_item.added.encrypted_content` = 空串，`done` / `completed` = 封包（三处不一致）
 *
 * 契约边界（别扩权，改前请先读）：
 * - 来源绑定只绑「上游来源 = `vendor:<id>`」，不绑 host / 账号 / 端点；`vendor` 表把同一家供应商
 *   拆成多行时，凭据不跨行复用（宁可明确拒绝，也不把上游的报错原样透传）
 * - 凭据里 **没有** `source` 字段的老凭据仍然通过校验（向后兼容窗口，见报告「缺口」章节）
 * - 不保证「同一模型名的不同来源产出可互换」；不碰计费 / usage / 缓存标记
 */
import { describe, it, expect } from "vitest";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ApiFormat, FailedCode } from "../../../src/constants";
import protocolConverterUtil from "../../../src/util/protocolConverter/protocolConverterUtil";
import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";

type AnyRecord = Record<string, any>;

/** 客户端请求名（别名路由：客户端认这个名字，上游叫别的） */
const CLIENT_MODEL = "client-alias";
/** 上游实际模型名 1 / 2（两个不同的值，用来证明输出不随上游变化） */
const UPSTREAM_MODEL = "upstream-actual-version";
const UPSTREAM_MODEL_ALT = "third-vendor-name";
/** 网关替换后发给上游的模型名（vendor model） */
const VENDOR_MODEL = "vendor-model-name";
/** 上游来源（网关侧标识） */
const SOURCE = "vendor:1";
const SOURCE_OTHER = "vendor:2";

const j = (o: unknown) => JSON.stringify(o);

/**
 * 按 senderService 的真实顺序造一个转换器：先注入客户端请求名与命中来源，再转换请求体。
 * （senderService 在 `ConverterFactory.create` 之后、`convertRequestBody` 之前做这两步，
 *  顺序错了请求侧的凭据解封就核不上。）
 */
function makeConverter(
    clientFormat: ApiFormat,
    upstreamFormat: ApiFormat,
    clientModel = CLIENT_MODEL,
    source = SOURCE,
) {
    const conv = ConverterFactory.create(clientFormat, upstreamFormat) as any;
    conv.updateClientModel(clientModel);
    conv.setCredentialSource(source);
    return conv as any;
}

function runStream(conv: any, frames: AnyRecord[]) {
    const events: ProtocolStreamEvent[] = [];
    for (const f of frames) events.push(...conv.convertStreamEvent(j(f)));
    return events.map((e) => JSON.parse(e.data as string) as AnyRecord);
}

const reasoningOf = (output: AnyRecord[]) => output.find((b) => b.type === "reasoning") as AnyRecord;
const thinkingOf = (content: AnyRecord[]) => content.find((b) => b.type === "thinking");

// ============================================================
// A. PC-009-C：别名请求 → 响应 → 下一轮回放的本地往返实收
//    方向：客户端 Responses ← 上游 Anthropic
// ============================================================

describe("PC-009-C 别名身份往返（客户端 Responses ← 上游 Anthropic）", () => {
    const anthropicUpstream = (model = UPSTREAM_MODEL) => ({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "thinking", thinking: "think", signature: "native-sig" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
    });

    /** 第一轮：上游 Anthropic 响应 → 客户端 Responses 响应，返回 reasoning 项（下一轮要回传的东西） */
    function firstRound() {
        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        const res = conv.convertResponse(anthropicUpstream(), "req-1") as AnyRecord;
        const reasoning = reasoningOf(res.output);
        expect(reasoning, "第一轮响应里必须出现 reasoning 项").toBeTruthy();
        return reasoning!;
    }

    /** 第二轮：把 reasoning 项放回 input 再转成上游请求（body.model 已是网关替换后的 vendor 名） */
    function replay(reasoning: AnyRecord, clientModel = CLIENT_MODEL, source = SOURCE) {
        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, clientModel, source);
        return conv.convertRequest({
            model: VENDOR_MODEL,
            input: [
                { role: "user", content: [{ type: "input_text", text: "hi" }] },
                reasoning,
            ],
        } as any) as AnyRecord;
    }

    it("A1 合法回放：能解出上游原始签名，模型名不变", () => {
        const reasoning = firstRound();
        // 响应里的 model 是客户端请求名（§4.7），凭据是对客户端不透明的字符串
        expect(typeof reasoning.encrypted_content).toBe("string");
        expect(reasoning.encrypted_content).not.toBe("native-sig");
        // 凭据内部绑的是客户端请求名，不是上游名
        const unsealed = protocolConverterUtil.unsealThinkingSignature(
            reasoning.encrypted_content,
            "anthropic",
            CLIENT_MODEL,
            SOURCE,
        );
        expect(unsealed?.signature, "凭据必须能解出上游原始签名").toBe("native-sig");

        // 下一轮：签名恢复成上游原始值，thinking 明文也在
        const replayConv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        expect(replayConv.isCredentialSourceUnchecked(), "新凭据的来源必须真的校验过").toBe(false);
        const upstreamReq = replayConv.convertRequest({
            model: VENDOR_MODEL,
            input: [
                { role: "user", content: [{ type: "input_text", text: "hi" }] },
                reasoning,
            ],
        } as any) as AnyRecord;
        expect(replayConv.isCredentialSourceUnchecked()).toBe(false);
        const block = thinkingOf(
            (upstreamReq.messages as AnyRecord[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
        );
        expect(block, "回放后的上游请求里必须带 thinking 块").toBeTruthy();
        expect(block!.signature).toBe("native-sig");
        expect(block!.thinking).toBe("think");
    });

    it("A2 不兼容模型名：明确拒绝（400 + invalid_request_error + conversion_error）", () => {
        const reasoning = firstRound();
        let caught: any;
        try {
            replay(reasoning, "another-model");
        } catch (e) {
            caught = e;
        }
        expect(caught, "换了模型名必须拒绝，不能静默通过").toBeTruthy();
        expect(caught.statusCode).toBe(400);
        expect(caught.code).toBe("invalid_request_error");
        expect(caught.failedCode).toBe(FailedCode.CONVERSION_ERROR);
        expect(caught.message).toContain("Incompatible or unverified");
    });

    it("A3 不兼容来源（同模型名）：明确拒绝（400 + invalid_request_error + conversion_error）", () => {
        const reasoning = firstRound();
        let caught: any;
        try {
            replay(reasoning, CLIENT_MODEL, SOURCE_OTHER);
        } catch (e) {
            caught = e;
        }
        expect(caught, "同模型名但换了上游来源也必须拒绝").toBeTruthy();
        expect(caught.statusCode).toBe(400);
        expect(caught.code).toBe("invalid_request_error");
        expect(caught.failedCode).toBe(FailedCode.CONVERSION_ERROR);
    });

    it("A4 老凭据（封包无 source 字段）仍然通过：升级不打断在途多轮", () => {
        // 模拟旧版本签发的凭据：payload 里没有 source
        const legacy = protocolConverterUtil.sealThinkingSignature("anthropic", "native-sig", {
            model: CLIENT_MODEL,
            thinking: "think",
        });
        expect(legacy).not.toContain("source");
        const reasoning = { type: "reasoning", summary: [{ type: "summary_text", text: "think" }], encrypted_content: legacy };

        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, CLIENT_MODEL, SOURCE_OTHER);
        const upstreamReq = conv.convertRequest({
            model: VENDOR_MODEL,
            input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, reasoning],
        } as any) as AnyRecord;
        const block = thinkingOf(
            (upstreamReq.messages as AnyRecord[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
        );
        expect(block?.signature).toBe("native-sig");
        // 通过不等于「校验过」：来源未校验必须留痕，否则缺口不可观测（入口据此写 warn 活动）
        expect(conv.isCredentialSourceUnchecked(), "老凭据必须标记「来源未校验」").toBe(true);
    });

    it("A4b 老凭据 + 来源不一致也照样通过（这正是兼容窗口本身，必须显式锁住）", () => {
        const legacy = protocolConverterUtil.sealThinkingSignature("anthropic", "native-sig", {
            model: CLIENT_MODEL,
            thinking: "think",
        });
        const reasoning = {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "think" }],
            encrypted_content: legacy,
        };
        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC, CLIENT_MODEL, "vendor:999");
        const upstreamReq = conv.convertRequest({
            model: VENDOR_MODEL,
            input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, reasoning],
        } as any) as AnyRecord;
        const block = thinkingOf(
            (upstreamReq.messages as AnyRecord[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
        );
        expect(block?.signature).toBe("native-sig");
        expect(conv.isCredentialSourceUnchecked()).toBe(true);
    });

    it("A5 上游换了模型名，往返仍然成立（凭据不绑上游名）", () => {
        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        const res = conv.convertResponse(anthropicUpstream(UPSTREAM_MODEL_ALT), "req-1") as AnyRecord;
        const upstreamReq = replay(reasoningOf(res.output));
        const block = thinkingOf(
            (upstreamReq.messages as AnyRecord[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
        );
        expect(block?.signature).toBe("native-sig");
    });
});

// ============================================================
// B. PC-009-C：反方向（客户端 Anthropic ← 上游 Responses）
// ============================================================

describe("PC-009-C 别名身份往返（客户端 Anthropic ← 上游 Responses）", () => {
    const responsesUpstream = {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: UPSTREAM_MODEL,
        output: [
            {
                id: "rs_1",
                type: "reasoning",
                summary: [{ type: "summary_text", text: "think" }],
                encrypted_content: "cipher-abc",
            },
            { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };

    function firstRound() {
        const conv = makeConverter(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES);
        const res = conv.convertResponse(responsesUpstream as any) as AnyRecord;
        const block = thinkingOf(res.content);
        expect(block, "Anthropic 客户端必须看到 thinking 块").toBeTruthy();
        return block!;
    }

    function replay(block: AnyRecord, source = SOURCE) {
        const conv = makeConverter(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES, CLIENT_MODEL, source);
        return conv.convertRequest({
            model: CLIENT_MODEL,
            max_tokens: 16,
            messages: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                { role: "assistant", content: [block, { type: "text", text: "hi" }] },
            ],
        } as any) as AnyRecord;
    }

    it("B1 合法回放：encrypted_content 恢复成上游原密文", () => {
        const block = firstRound();
        expect(block.signature).not.toBe("cipher-abc");
        const upstreamReq = replay(block);
        const reasoning = (upstreamReq.input as AnyRecord[]).find((i) => i.type === "reasoning");
        expect(reasoning?.encrypted_content).toBe("cipher-abc");
    });

    it("B2 不兼容来源：明确拒绝", () => {
        const block = firstRound();
        let caught: any;
        try {
            replay(block, SOURCE_OTHER);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeTruthy();
        expect(caught.statusCode).toBe(400);
        expect(caught.code).toBe("invalid_request_error");
        expect(caught.failedCode).toBe(FailedCode.CONVERSION_ERROR);
    });
});

// ============================================================
// C. §4.7：响应里的 model 必须是客户端请求名
// ============================================================

describe("§4.7 响应 model == 客户端请求名", () => {
    it("C1 非流式（客户端 Responses）：上游名 / 换一个上游名 都不影响", () => {
        for (const upstreamModel of [UPSTREAM_MODEL, UPSTREAM_MODEL_ALT]) {
            const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
            const res = conv.convertResponse(
                {
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    model: upstreamModel,
                    content: [{ type: "text", text: "hi" }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 1, output_tokens: 1 },
                } as any,
                "req-1",
            ) as AnyRecord;
            expect(res.model, `上游 model=${upstreamModel} 时客户端应仍看到请求名`).toBe(CLIENT_MODEL);
        }
    });

    it("C2 流式（客户端 Responses）：created / completed 都是客户端请求名，且不随上游改名", () => {
        for (const upstreamModel of [UPSTREAM_MODEL, UPSTREAM_MODEL_ALT]) {
            const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
            const parsed = runStream(conv, [
                {
                    type: "message_start",
                    message: { id: "msg_1", model: upstreamModel, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } },
                },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
                { type: "content_block_stop", index: 0 },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                { type: "message_stop" },
            ]);
            const created = parsed.find((e) => e.type === "response.created");
            const completed = parsed.find((e) => e.type === "response.completed");
            expect(created?.response?.model, "created 帧必须带客户端请求名").toBe(CLIENT_MODEL);
            expect(completed?.response?.model, "completed 帧必须是客户端请求名").toBe(CLIENT_MODEL);
        }
    });

    it("C3 反方向非流式（客户端 Anthropic ← 上游 Responses）", () => {
        const conv = makeConverter(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES);
        const res = conv.convertResponse(
            {
                id: "resp_1",
                object: "response",
                created_at: 1,
                status: "completed",
                model: UPSTREAM_MODEL,
                output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            } as any,
        ) as AnyRecord;
        expect(res.model).toBe(CLIENT_MODEL);
    });

    it("C4 客户端名与上游名都不等于 vendor 名时也不串味（三个名字互不相同）", () => {
        const conv = makeConverter(ApiFormat.OPENAI, ApiFormat.ANTHROPIC, "client-chat-alias");
        const res = conv.convertResponse(
            {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: UPSTREAM_MODEL,
                content: [{ type: "text", text: "hi" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
            } as any,
        ) as AnyRecord;
        expect(res.model).toBe("client-chat-alias");
        expect(res.model).not.toBe(VENDOR_MODEL);
    });
});

// ============================================================
// D. §4.6：added / done / completed 三处凭据表示一致
// ============================================================

describe("§4.6 三处凭据表示一致（Anthropic 上游 → Responses 客户端流式）", () => {
    function streamReasoning() {
        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        const parsed = runStream(conv, [
            {
                type: "message_start",
                message: { id: "msg_1", model: UPSTREAM_MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } },
            },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "native-sig" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
        ]);
        const added = parsed.find((e) => e.type === "response.output_item.added");
        const done = parsed.find((e) => e.type === "response.output_item.done");
        const completed = parsed.find((e) => e.type === "response.completed");
        return {
            added: added?.item,
            done: done?.item,
            completed: (completed?.response?.output as AnyRecord[] | undefined)?.find((i) => i.type === "reasoning"),
        };
    }

    it("D1 还没拿到凭据的阶段不带 encrypted_content（不是空串占位）", () => {
        const { added } = streamReasoning();
        expect(added, "必须有 output_item.added(reasoning)").toBeTruthy();
        expect(added.encrypted_content, "未完成的 reasoning 项不能带空串 encrypted_content").toBeUndefined();
        expect("encrypted_content" in added).toBe(false);
    });

    it("D2 done 与 completed 携带同一份凭据（逐字节相同）且可解出原签名", () => {
        const { done, completed } = streamReasoning();
        expect(typeof done?.encrypted_content).toBe("string");
        expect(done!.encrypted_content).not.toBe("");
        expect(completed?.encrypted_content, "done 与 completed 必须是同一份凭据").toBe(done!.encrypted_content);
        const unsealed = protocolConverterUtil.unsealThinkingSignature(
            done!.encrypted_content,
            "anthropic",
            CLIENT_MODEL,
            SOURCE,
        );
        expect(unsealed?.signature).toBe("native-sig");
    });

    it("D3 流式攒出的 reasoning 项能直接进下一轮请求（联跑闭环）", () => {
        const { completed } = streamReasoning();
        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        const upstreamReq = conv.convertRequest({
            model: VENDOR_MODEL,
            input: [
                { role: "user", content: [{ type: "input_text", text: "hi" }] },
                completed,
            ],
        } as any) as AnyRecord;
        const block = thinkingOf(
            (upstreamReq.messages as AnyRecord[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
        );
        expect(block?.signature).toBe("native-sig");
    });
});

// ============================================================
// E. 联跑：四条判据在同一个转换器实例上依次成立（防单点互相踩）
// ============================================================

describe("联跑：同一实例上 §4.7 / §4.6 / PC-009-C 同时成立", () => {
    it("E1 一次流式响应既满足 model 身份、也满足三处凭据一致与可回放", () => {
        const conv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        const parsed = runStream(conv, [
            {
                type: "message_start",
                message: { id: "msg_1", model: UPSTREAM_MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } },
            },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "native-sig" } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
        ]);

        const completed = parsed.find((e) => e.type === "response.completed")!;
        expect(completed.response.model).toBe(CLIENT_MODEL);

        const reasoning = (completed.response.output as AnyRecord[]).find((i) => i.type === "reasoning")!;
        const done = parsed.find((e) => e.type === "response.output_item.done")!.item as AnyRecord;
        expect(done.encrypted_content).toBe(reasoning.encrypted_content);

        const replayConv = makeConverter(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        const upstreamReq = replayConv.convertRequest({
            model: VENDOR_MODEL,
            input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, reasoning],
        } as any) as AnyRecord;
        const block = thinkingOf(
            (upstreamReq.messages as AnyRecord[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
        );
        expect(block?.signature).toBe("native-sig");
    });
});

// ============================================================
// F. 行为对照（只用基线就存在的 API：`create(f, f, 模型名)`）
//    这些用例的价值是「在改前代码上因**行为**而红」，而不是因为新方法不存在而红。
// ============================================================

describe("F 行为对照：仅用基线 API 也必须在改前变红", () => {
    const conv = (clientFormat: ApiFormat, upstreamFormat: ApiFormat) =>
        ConverterFactory.create(clientFormat, upstreamFormat, CLIENT_MODEL) as any;

    it("F1 非流式：响应 model 不跟上游名走", () => {
        const res = conv(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC).convertResponse({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: UPSTREAM_MODEL,
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
        }) as AnyRecord;
        expect(res.model).toBe(CLIENT_MODEL);
    });

    it("F2 流式：created / completed 的 model 都是请求名", () => {
        const parsed = runStream(conv(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC), [
            {
                type: "message_start",
                message: { id: "msg_1", model: UPSTREAM_MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } },
            },
            { type: "message_stop" },
        ]);
        expect(parsed.find((e) => e.type === "response.created")?.response?.model).toBe(CLIENT_MODEL);
        expect(parsed.find((e) => e.type === "response.completed")?.response?.model).toBe(CLIENT_MODEL);
    });

    it("F3 三处凭据：added 不带空串，done 与 completed 同值", () => {
        const parsed = runStream(conv(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC), [
            {
                type: "message_start",
                message: { id: "msg_1", model: UPSTREAM_MODEL, role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } },
            },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "native-sig" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_stop" },
        ]);
        const added = parsed.find((e) => e.type === "response.output_item.added")!.item as AnyRecord;
        const done = parsed.find((e) => e.type === "response.output_item.done")!.item as AnyRecord;
        const completed = (parsed.find((e) => e.type === "response.completed")!.response.output as AnyRecord[]).find(
            (i) => i.type === "reasoning",
        )!;
        expect(added.encrypted_content).toBeUndefined();
        expect(done.encrypted_content).toBe(completed.encrypted_content);
    });

    it("F4 往返（请求体 model 未替换成 vendor 名的最小链路）：不 400", () => {
        const c = conv(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        const reasoning = reasoningOf(
            (c.convertResponse({
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: UPSTREAM_MODEL,
                content: [{ type: "thinking", thinking: "think", signature: "native-sig" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
            }) as AnyRecord).output,
        );
        const next = conv(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC).convertRequest({
            model: CLIENT_MODEL,
            input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, reasoning],
        } as any) as AnyRecord;
        const block = thinkingOf(
            (next.messages as AnyRecord[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
        );
        expect(block?.signature).toBe("native-sig");
    });
});
