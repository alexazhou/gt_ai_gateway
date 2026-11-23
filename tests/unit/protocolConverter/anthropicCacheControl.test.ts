/**
 * Anthropic 请求缓存标记（cache_control）补全 —— 设计文档 §8.1 十二个场景的判定用例。
 *
 * 方案：`doc/tech/anthropic_cache_control_design.md`（讨论稿定稿，本单只实现不重新设计）。
 * 落点：`protocolConverterUtil.applyAnthropicCacheControl`，由 Chat→Anthropic 与
 *       Responses→Anthropic 两条 `convertRequest` 的返回前各调用一次（同一个函数）。
 *
 * 覆盖（对应 §8.1 表格顺序）：
 *  1. Chat 的 system 字符串和 user 字符串
 *  2. Responses 的 instructions、function tools 和 user input
 *  3. 多条 system / developer 指令
 *  4. 文本 / 图片混合消息
 *  5. 多个工具结果回传
 *  6. 历史存在 thinking / signature
 *  7. 空 system、空内容、无工具
 *  8. 候选位置已有合法标记
 *  9. 已有标记占满或超过上限
 * 10. 工具 schema / 业务数据包含 cache_control
 * 11. 同一请求重复补全（幂等）
 * 12. 真实支持缓存的上游 —— 无凭据环境**未覆盖**，见报告「未覆盖项」
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import { ResponsesToAnthropicConverter } from "../../../src/util/protocolConverter/ResponsesToAnthropicConverter";
import protocolConverterUtil from "../../../src/util/protocolConverter/protocolConverterUtil";
import type {
    AnthropicCacheControl,
    AnthropicContentBlock,
    AnthropicRequest,
    AnthropicTool,
} from "../../../src/util/protocol/anthropicTypes";
import type { OpenAIRequest } from "../../../src/util/protocol/openaiTypes";
import type { ResponsesRequest } from "../../../src/util/protocol/responsesTypes";

const EPHEMERAL: AnthropicCacheControl = { type: "ephemeral" };

/** 收集请求里所有**协议位置**上的 cache_control（工具顶层 / system 块 / 内容块）。 */
function collectBreakpoints(req: AnthropicRequest): Array<{ where: string; value: AnthropicCacheControl }> {
    const found: Array<{ where: string; value: AnthropicCacheControl }> = [];
    (req.tools ?? []).forEach((tool: AnthropicTool, index: number) => {
        if (tool.cache_control) {
            found.push({ where: `tools[${index}]`, value: tool.cache_control });
        }
    });
    if (Array.isArray(req.system)) {
        req.system.forEach((block, index) => {
            if (block.cache_control) {
                found.push({ where: `system[${index}]`, value: block.cache_control });
            }
        });
    }
    req.messages.forEach((message, messageIndex) => {
        if (!Array.isArray(message.content)) {
            return;
        }
        message.content.forEach((block: AnthropicContentBlock, blockIndex: number) => {
            if (block.cache_control) {
                found.push({ where: `messages[${messageIndex}].content[${blockIndex}]`, value: block.cache_control });
            }
        });
    });
    return found;
}

describe("Anthropic cache_control 补全（#295 §8.1）", () => {
    let chatConverter: OpenAIToAnthropicConverter;
    let responsesConverter: ResponsesToAnthropicConverter;

    beforeEach(() => {
        chatConverter = new OpenAIToAnthropicConverter();
        responsesConverter = new ResponsesToAnthropicConverter();
    });

    // ── 1. Chat 的 system 字符串和 user 字符串 ───────────────────────────────
    it("场景1：Chat 的 system / user 字符串 → 规范化为 text 块并加标记，文本逐字一致", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "system", content: "系统提示词：逐字\n保留 空格" },
                { role: "user", content: "用户当前问题" },
            ],
            max_tokens: 128,
        };

        const req = chatConverter.convertRequest(openaiReq);

        expect(req.system).toEqual([
            { type: "text", text: "系统提示词：逐字\n保留 空格", cache_control: EPHEMERAL },
        ]);
        expect(req.messages).toHaveLength(1);
        expect(req.messages[0].content).toEqual([
            { type: "text", text: "用户当前问题", cache_control: EPHEMERAL },
        ]);
        // 三处候选里只有 system / messages 存在 ⇒ 恰好 2 个断点，且都是 ephemeral 且不设 ttl
        const marks = collectBreakpoints(req);
        expect(marks).toHaveLength(2);
        expect(marks.every((m) => m.value.type === "ephemeral" && m.value.ttl === undefined)).toBe(true);
    });

    // ── 2. Responses 的 instructions / function tools / user input ───────────
    it("场景2：Responses 的 instructions + function tools + user input → 与等价 Chat 相同的三个候选位置", () => {
        const responsesReq: ResponsesRequest = {
            model: "claude-model",
            instructions: "系统提示词",
            input: "用户当前问题",
            tools: [
                {
                    type: "function",
                    name: "lookup",
                    description: "查询指定条目",
                    parameters: { type: "object", properties: { key: { type: "string" } } },
                },
            ],
            max_output_tokens: 128,
        };

        const req = responsesConverter.convertRequest(responsesReq);
        const where = collectBreakpoints(req).map((m) => m.where).sort();

        expect(where).toEqual([
            "messages[0].content[0]",
            "system[0]",
            "tools[0]",
        ]);
    });

    // ── 3. 多条 system / developer 指令 ──────────────────────────────────────
    it("场景3：多条 system / developer 指令 → 汇总顺序不变，在最终 system 块加标记", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "system", content: "第一条" },
                { role: "developer", content: "第二条" },
                { role: "user", content: "问题" },
            ],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);

        expect(req.system).toEqual([{ type: "text", text: "第一条\n\n第二条", cache_control: EPHEMERAL }]);
    });

    // ── 4. 文本 / 图片混合消息 ───────────────────────────────────────────────
    it("场景4：文本/图片混合 → 顺序与图片字段不变，在最后可标记块加标记", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "看这张图" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                    ],
                },
            ],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);
        const blocks = req.messages[0].content as AnthropicContentBlock[];

        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toEqual({ type: "text", text: "看这张图" });
        expect(blocks[0].cache_control).toBeUndefined();
        expect(blocks[1].type).toBe("image");
        expect(blocks[1].source).toEqual({ type: "base64", media_type: "image/png", data: "AAAA" });
        expect(blocks[1].cache_control).toEqual(EPHEMERAL);
    });

    // ── 5. 多个工具结果回传 ──────────────────────────────────────────────────
    it("场景5：多个工具结果 → tool_use_id / 内容 / 轮次不变，标记最后一个 tool_result 外层块", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "user", content: "帮我查两个" },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                        { id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"key\":\"a\"}" } },
                        { id: "call_b", type: "function", function: { name: "lookup", arguments: "{\"key\":\"b\"}" } },
                    ],
                },
                { role: "tool", tool_call_id: "call_a", content: "结果 A" },
                { role: "tool", tool_call_id: "call_b", content: "结果 B" },
            ],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);
        const lastUser = req.messages[req.messages.length - 1];
        const blocks = lastUser.content as AnthropicContentBlock[];

        expect(lastUser.role).toBe("user");
        expect(blocks.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
        expect(blocks[0].tool_use_id).toBe("call_a");
        expect(blocks[1].tool_use_id).toBe("call_b");
        expect(blocks[1].content).toBe("结果 B");
        expect(blocks[0].cache_control).toBeUndefined();
        expect(blocks[1].cache_control).toEqual(EPHEMERAL);
    });

    // ── 6. 历史存在 thinking / signature ────────────────────────────────────
    it("场景6：历史含 thinking/signature → 不加 cache 字段，也不改原始凭据", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "user", content: "第一问" },
                { role: "assistant", content: "答", reasoning_content: "思考过程" },
                { role: "user", content: "第二问" },
            ],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);
        const assistant = req.messages[1];
        const thinkingBlock = (assistant.content as AnthropicContentBlock[]).find((b) => b.type === "thinking");

        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock?.thinking).toBe("思考过程");
        expect(thinkingBlock?.cache_control).toBeUndefined();
        // 最后一个断点落在最后一条 user 上，不在 thinking 上
        const marks = collectBreakpoints(req);
        expect(marks.map((m) => m.where)).toEqual(["messages[2].content[0]"]);
    });

    it("场景6b：最后一条 user 没有可标记块时，也不越界去标历史 thinking", () => {
        // 说明：场景6 的末尾是普通 user 文本，实现根本走不到 thinking，
        // 单看那条断言无法失败（判别力≈0）。这里把「最后一条 user 不可标记」摆出来，
        // 且让 assistant 只有 thinking 块 —— 这样「把 thinking 当可标记位置 / 越界标 assistant」
        // 的变异会真的变红。
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            // 形状由转换层统一产出（方案 B）：这里直接给块数组，补全只加字段
            system: [{ type: "text", text: "系统" }],
            messages: [
                { role: "user", content: [{ type: "text", text: "第一问" }] },
                {
                    role: "assistant",
                    content: [{ type: "thinking", thinking: "思考过程", signature: "sig-abc" }],
                },
                { role: "user", content: [] },
            ],
        };

        const result = protocolConverterUtil.applyAnthropicCacheControl(req);
        const thinkingBlock = (result.messages[1].content as AnthropicContentBlock[])
            .find((b) => b.type === "thinking");

        expect(thinkingBlock?.cache_control).toBeUndefined();
        // thinking 的明文与 signature 也不该被改动
        expect(thinkingBlock?.thinking).toBe("思考过程");
        expect(thinkingBlock?.signature).toBe("sig-abc");
        // 消息断点跳过，只有 system 拿到预算
        expect(collectBreakpoints(result).map((m) => m.where)).toEqual(["system[0]"]);
    });

    // ── 7. 空 system / 空内容 / 无工具 ───────────────────────────────────────
    it("场景7：空 system、空内容、无工具 → 不生成占位块和无意义标记", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "system", content: "" },
                { role: "user", content: "" },
            ],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);

        expect(req.system).toBeUndefined();
        expect(req.tools).toBeUndefined();
        // 方案 B：空内容产出空块数组（不生成占位文本块），因此没有可标记位置
        expect(req.messages[0].content).toEqual([]);
        expect(collectBreakpoints(req)).toHaveLength(0);
    });

    // ── 8. 候选位置已有合法标记 ──────────────────────────────────────────────
    it("场景8：候选位置已有合法标记 → 保留位置与设置，按剩余预算补充其它区域", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            system: [{ type: "text", text: "系统", cache_control: { type: "ephemeral", ttl: "1h" } }],
            messages: [{ role: "user", content: [{ type: "text", text: "问题" }] }],
            tools: [{ name: "lookup", input_schema: { type: "object" } }],
        };

        const result = protocolConverterUtil.applyAnthropicCacheControl(req);
        const marks = collectBreakpoints(result);

        // system 上原有的标记原样保留（ttl 不被覆盖、不重复添加）
        expect(result.system).toEqual([{ type: "text", text: "系统", cache_control: { type: "ephemeral", ttl: "1h" } }]);
        expect(marks.map((m) => m.where).sort()).toEqual([
            "messages[0].content[0]",
            "system[0]",
            "tools[0]",
        ]);
    });

    // ── 9. 已有标记占满 / 超过上限 ───────────────────────────────────────────
    it("场景9a：已有标记占满预算（4 个）→ 不新增任何断点", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            tools: [
                { name: "t1", input_schema: {}, cache_control: EPHEMERAL },
                { name: "t2", input_schema: {}, cache_control: EPHEMERAL },
            ],
            system: [{ type: "text", text: "系统", cache_control: EPHEMERAL }],
            messages: [{
                role: "user",
                content: [{ type: "text", text: "已标记", cache_control: EPHEMERAL }],
            }],
        };

        const result = protocolConverterUtil.applyAnthropicCacheControl(req);

        expect(collectBreakpoints(result)).toHaveLength(4);
        // 未新增：原本没有标记的位置仍然没有
        expect(result.messages[0].content).toEqual([
            { type: "text", text: "已标记", cache_control: EPHEMERAL },
        ]);
    });

    it("场景9b：已有标记超过上限 → 明确拒绝（400），不静默删除客户端标记", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            tools: Array.from({ length: 5 }, (_, index) => ({
                name: `t${index}`,
                input_schema: {},
                cache_control: EPHEMERAL,
            })),
            messages: [{ role: "user", content: "问题" }],
        };

        // 文案必须自带三件事：位置 / 原因（超上限）/ 上限值
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).toThrowError(/exceeding the limit of 4/);
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).toThrowError(/tools\[0\]/);
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).toThrowError(/tools\[4\]/);
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).toThrowError(/carries 5 cache breakpoints/);
        // 拒绝时不改动请求：5 个标记原样在
        expect(collectBreakpoints(req)).toHaveLength(5);
    });

    it("场景9c：已有标记非法（type 不是 ephemeral）→ 明确拒绝并点名位置", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            messages: [{
                role: "user",
                content: [{ type: "text", text: "问题", cache_control: { type: "persistent" } as unknown as AnthropicCacheControl }],
            }],
        };

        // 位置 / 原因（不支持取值，且与「超上限」措辞可区分）/ 上限值
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).toThrowError(/messages\[0\]\.content\[0\]/);
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).toThrowError(/unsupported value/);
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).toThrowError(/at most 4 cache breakpoints/);
        // 原因可区分：非法这一条不能出现「超上限」的措辞
        expect(() => protocolConverterUtil.applyAnthropicCacheControl(req)).not.toThrowError(/exceeding the limit/);
    });

    // ── 10. 工具 schema / 业务数据包含 cache_control ─────────────────────────
    it("场景10：工具 input_schema 里的 cache_control 是业务数据，不当作协议断点、也不影响预算", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            tools: [{
                name: "lookup",
                input_schema: {
                    type: "object",
                    properties: {
                        cache_control: { type: "object", description: "业务字段，名字恰好相同" },
                    },
                },
            }],
            messages: [{
                role: "user",
                content: [{
                    type: "tool_result",
                    tool_use_id: "call_1",
                    content: "{\"cache_control\": {\"type\": \"ephemeral\"}}",
                }],
            }],
        };

        const result = protocolConverterUtil.applyAnthropicCacheControl(req);
        const marks = collectBreakpoints(result);

        // 只有协议位置被标记：tools[0] 顶层 + 消息里的 tool_result 外层块
        expect(marks.map((m) => m.where).sort()).toEqual(["messages[0].content[0]", "tools[0]"]);
        // input_schema 里的业务字段原样未动
        expect((result.tools?.[0].input_schema as { properties: Record<string, unknown> }).properties.cache_control)
            .toEqual({ type: "object", description: "业务字段，名字恰好相同" });
        // tool_result 的业务 content 字符串也未变
        expect((result.messages[0].content as AnthropicContentBlock[])[0].content)
            .toBe("{\"cache_control\": {\"type\": \"ephemeral\"}}");
    });

    // ── 11. 同一请求重复补全（幂等） ─────────────────────────────────────────
    it("场景11：同一请求重复补全 → 标记数量与内容不变（幂等）", () => {
        // 关键设计：最后一条 user 用**多块**消息（text + image）。
        // 单块消息下「已标记就停手」与「已标记还往前找空块」看不出差别，
        // 多块才能让「忘了 skip 已标记块」这种不幂等的实现真的变红。
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "system", content: "系统提示词" },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "看这张图" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                    ],
                },
            ],
            tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);
        const snapshot = JSON.parse(JSON.stringify(req)) as AnthropicRequest;
        // 首轮补全的断点：messages 尾块 + system + 工具，共 3 个
        expect(collectBreakpoints(req)).toHaveLength(3);

        const again = protocolConverterUtil.applyAnthropicCacheControl(req);
        const third = protocolConverterUtil.applyAnthropicCacheControl(again);

        expect(collectBreakpoints(third)).toHaveLength(3);
        expect(JSON.parse(JSON.stringify(third))).toEqual(snapshot);
    });

    // ── 预算不足时的补充优先级（§4.4 第 3 条） ───────────────────────────────
    it("预算只剩 1 个时，优先补消息断点（消息 → system → tools）", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            tools: [
                { name: "t1", input_schema: {}, cache_control: EPHEMERAL },
                { name: "t2", input_schema: {}, cache_control: EPHEMERAL },
                { name: "t3", input_schema: {}, cache_control: EPHEMERAL },
            ],
            system: [{ type: "text", text: "系统" }],
            messages: [{ role: "user", content: [{ type: "text", text: "问题" }] }],
        };

        const result = protocolConverterUtil.applyAnthropicCacheControl(req);

        expect(collectBreakpoints(result).map((m) => m.where).sort()).toEqual([
            "messages[0].content[0]",
            "tools[0]",
            "tools[1]",
            "tools[2]",
        ]);
        // system 没拿到预算 ⇒ 不加字段（形状本就由转换层产出，此处不动）
        expect(result.system).toEqual([{ type: "text", text: "系统" }]);
    });

    // ── 边界：没有 user 消息时不越界标记 assistant（§4.3 末段） ───────────────
    it("边界：请求以 assistant 预填结束时，不自动标记末尾 assistant，仅补 system / tools", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            system: [{ type: "text", text: "系统" }],
            messages: [
                { role: "user", content: [{ type: "text", text: "问题" }] },
                { role: "assistant", content: [{ type: "text", text: "预填" }] },
            ],
            tools: [{ name: "lookup", input_schema: {} }],
        };

        const result = protocolConverterUtil.applyAnthropicCacheControl(req);
        const marks = collectBreakpoints(result);

        // 消息断点落在**最后一条 user**（索引 0）上，而不是末尾 assistant
        expect(marks.map((m) => m.where).sort()).toEqual([
            "messages[0].content[0]",
            "system[0]",
            "tools[0]",
        ]);
    });

    // ── 方案 B（2026-11-23 Operator 定）：补全只加字段，绝不改请求形状 ──────────
    it("方案B-1：字符串形态的 system / content 一律跳过，绝不改写成块数组", () => {
        const req: AnthropicRequest = {
            model: "claude-model",
            max_tokens: 64,
            system: "系统",
            messages: [{ role: "user", content: "问题" }],
            tools: [{ name: "lookup", input_schema: {} }],
        };

        const result = protocolConverterUtil.applyAnthropicCacheControl(req);

        // 字符串位置：形状原样保留（仍是字符串），也没有标记
        expect(result.system).toBe("系统");
        expect(result.messages[0].content).toBe("问题");
        // 只有本来就是对象 / 块的位置拿到标记
        expect(collectBreakpoints(result).map((m) => m.where)).toEqual(["tools[0]"]);
    });

    it("方案B-2：转换层产出块数组（与是否补全无关），补全只加字段且幂等", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "system", content: "系统" },
                { role: "user", content: "问题" },
            ],
            tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);

        // 形状由转换器给出：system / content 都是块数组，标记是后加的字段
        expect(req.system).toEqual([{ type: "text", text: "系统", cache_control: EPHEMERAL }]);
        expect(req.messages[0].content).toEqual([{ type: "text", text: "问题", cache_control: EPHEMERAL }]);
        expect(collectBreakpoints(req).map((m) => m.where).sort()).toEqual([
            "messages[0].content[0]",
            "system[0]",
            "tools[0]",
        ]);

        // 再补一次：不新增断点、不重复包裹（幂等）
        const again = protocolConverterUtil.applyAnthropicCacheControl(req);
        expect(collectBreakpoints(again)).toHaveLength(3);
        expect(again.messages[0].content).toEqual([{ type: "text", text: "问题", cache_control: EPHEMERAL }]);
    });

    // ── 形状与标记解耦：覆盖「不加标记 / 部分加标记」的路径（两条转换路径各两组） ──
    // 这些用例的意义：方案 B 把形状变更的影响面从「加标记的请求」扩到「全部转 Anthropic 的
    // 请求」，所以形状必须能在**没有标记**的情况下被独立断言，不能只靠加标记的用例自证。
    it("解耦-1 Chat：无 system、无 tools，只有字符串 user ⇒ 形状是块数组，只有 1 个消息断点", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [{ role: "user", content: "只有消息" }],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);

        expect(req.system).toBeUndefined();
        expect(req.tools).toBeUndefined();
        expect(req.messages).toHaveLength(1);
        expect(req.messages[0].content).toEqual([{ type: "text", text: "只有消息", cache_control: EPHEMERAL }]);
        expect(collectBreakpoints(req).map((m) => m.where)).toEqual(["messages[0].content[0]"]);
    });

    it("解耦-2 Chat：字符串 system + 字符串 user + 空 tools 数组 ⇒ 2 个断点，空 tools 不产生标记", () => {
        const openaiReq: OpenAIRequest = {
            model: "claude-model",
            messages: [
                { role: "system", content: "系统" },
                { role: "user", content: "问题" },
            ],
            tools: [],
            max_tokens: 64,
        };

        const req = chatConverter.convertRequest(openaiReq);

        expect(req.system).toEqual([{ type: "text", text: "系统", cache_control: EPHEMERAL }]);
        expect(req.messages[0].content).toEqual([{ type: "text", text: "问题", cache_control: EPHEMERAL }]);
        expect(req.tools).toEqual([]);
        expect(collectBreakpoints(req).map((m) => m.where).sort()).toEqual([
            "messages[0].content[0]",
            "system[0]",
        ]);
    });

    it("解耦-3 Responses：空字符串 input、无 instructions、无 tools ⇒ 0 个断点，形状仍是块数组", () => {
        const responsesReq: ResponsesRequest = {
            model: "claude-model",
            input: "",
        };

        const req = responsesConverter.convertRequest(responsesReq);

        expect(req.system).toBeUndefined();
        expect(req.tools).toBeUndefined();
        // 形状由转换层产出，与是否加标记无关：空文本也是块，只是不可标记
        expect(req.messages[0].content).toEqual([{ type: "text", text: "" }]);
        expect(collectBreakpoints(req)).toHaveLength(0);
    });

    it("解耦-4 Responses：instructions + function_call_output ⇒ 断点落在 tool_result 外层块与 system，tool_use 不加标记", () => {
        const responsesReq: ResponsesRequest = {
            model: "claude-model",
            instructions: "系统提示词",
            input: [
                { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"key\":\"a\"}" },
                { type: "function_call_output", call_id: "call_1", output: "结果 A" },
            ],
        };

        const req = responsesConverter.convertRequest(responsesReq);
        const marks = collectBreakpoints(req);
        const assistant = req.messages[0];
        const lastUser = req.messages[req.messages.length - 1];

        expect(req.system).toEqual([{ type: "text", text: "系统提示词", cache_control: EPHEMERAL }]);
        // assistant 的 tool_use 块不加标记
        expect((assistant.content as AnthropicContentBlock[]).every((b) => b.cache_control === undefined)).toBe(true);
        // 断点落在 tool_result 外层块（它属于 user 消息的可标记块）
        const userBlocks = lastUser.content as AnthropicContentBlock[];
        expect(userBlocks.map((b) => b.type)).toEqual(["tool_result"]);
        expect(userBlocks[0].cache_control).toEqual(EPHEMERAL);
        expect(userBlocks[0].content).toBe("结果 A");
        expect(marks.map((m) => m.where).sort()).toEqual([
            "messages[1].content[0]",
            "system[0]",
        ]);
    });
});
