import { describe, it, expect } from "vitest";
import { OpenAIToResponsesConverter } from "../../../src/util/protocolConverter/OpenAIToResponsesConverter";
import type { OpenAIRequest } from "../../../src/util/protocol/openaiTypes";
import type { ResponsesNonStreamResponse } from "../../../src/util/protocol/responsesTypes";

/**
 * OpenAI → Responses 的「边缘但合法」请求/响应形态。
 *
 * 这些路径的共同特点：**漏了不会报错，只会静默降级**——
 * 多模态内容丢了图片、tool_choice 落回默认、incomplete 被当成 stop。
 * 所以每条都断言转换后的结构，而不是断言「调用过」。
 */
describe("OpenAIToResponsesConverter：边缘路径", () => {
    const converter = new OpenAIToResponsesConverter("gpt-4");

    const makeReq = (patch: Record<string, unknown>): OpenAIRequest =>
        ({ model: "gpt-4", ...patch }) as unknown as OpenAIRequest;

    it("user 多模态 content：text→input_text、image_url→input_image，且保持原顺序", () => {
        const result = converter.convertRequest(
            makeReq({
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "这张图里是什么？" },
                            { type: "image_url", image_url: { url: "https://example.com/a.png" } },
                        ],
                    },
                ],
            }),
        );

        expect(result.input).toHaveLength(1);
        expect(result.input[0]).toEqual({
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: "这张图里是什么？" },
                { type: "input_image", image_url: "https://example.com/a.png" },
            ],
        });
    });

    it("多模态里出现不支持的 part 类型 → 400（宁可拒绝，不静默丢弃图片/音频）", () => {
        const req = makeReq({
            messages: [
                { role: "user", content: [{ type: "audio", audio: { data: "AAAA" } }] },
            ],
        });

        expect(() => converter.convertRequest(req)).toThrowError(
            /Unsupported OpenAI content part type for protocol conversion: audio/,
        );
        try {
            converter.convertRequest(req);
        } catch (e) {
            expect((e as { statusCode?: number }).statusCode).toBe(400);
        }
    });

    it("user content 为空数组 → 不产生空 message 项（不制造空 input_text）", () => {
        const result = converter.convertRequest(
            makeReq({ messages: [{ role: "user", content: [] }] }),
        );

        expect(result.input).toEqual([]);
    });

    it("assistant 带 tool_calls 且 content 为字符串 → 文本消息 + function_call + function_call_output", () => {
        const result = converter.convertRequest(
            makeReq({
                messages: [
                    {
                        role: "assistant",
                        content: "我查一下天气",
                        tool_calls: [
                            {
                                id: "call_1",
                                type: "function",
                                function: { name: "get_weather", arguments: '{"city":"SH"}' },
                            },
                        ],
                    },
                    { role: "tool", tool_call_id: "call_1", content: "晴 25℃" },
                ],
            }),
        );

        expect(result.input).toEqual([
            {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "我查一下天气" }],
            },
            {
                type: "function_call",
                call_id: "call_1",
                name: "get_weather",
                arguments: '{"city":"SH"}',
            },
            { type: "function_call_output", call_id: "call_1", output: "晴 25℃" },
        ]);
    });

    it("max_tokens / max_completion_tokens 非正数或非数字 → 400", () => {
        for (const bad of [0, -1, "100" as unknown as number]) {
            const req = makeReq({ messages: [{ role: "user", content: "hi" }], max_tokens: bad });
            expect(() => converter.convertRequest(req)).toThrowError(/must be a positive number/);
        }

        // 合法值走 max_output_tokens（不叫 max_tokens）
        const ok = converter.convertRequest(
            makeReq({ messages: [{ role: "user", content: "hi" }], max_completion_tokens: 256 }),
        );
        expect(ok.max_output_tokens).toBe(256);
    });

    it('tool_choice "none" 原样保留（不允许上游再触发工具）', () => {
        const result = converter.convertRequest(
            makeReq({ messages: [{ role: "user", content: "hi" }], tool_choice: "none" }),
        );

        expect(result.tool_choice).toBe("none");
    });

    it("reasoning_effort → reasoning.effort（不做静默丢弃）", () => {
        const result = converter.convertRequest(
            makeReq({ messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }),
        );

        expect(result.reasoning).toEqual({ effort: "high" });
    });

    it("system content 为 null → 不产生 instructions（空文本不写入）", () => {
        const result = converter.convertRequest(
            makeReq({
                messages: [
                    { role: "system", content: null },
                    { role: "user", content: "hi" },
                ],
            }),
        );

        expect(result.instructions).toBeUndefined();
        expect(result.input).toHaveLength(1);
    });

    it("上游 status=incomplete：content_filter 与 length 分别映射到 finish_reason", () => {
        const makeRes = (reason: string): ResponsesNonStreamResponse =>
            ({
                id: "resp_1",
                model: "gpt-4",
                status: "incomplete",
                incomplete_details: { reason },
                output: [],
                usage: { input_tokens: 10, output_tokens: 2 },
            }) as unknown as ResponsesNonStreamResponse;

        expect(converter.convertResponse(makeRes("content_filter")).choices[0].finish_reason).toBe(
            "content_filter",
        );
        expect(converter.convertResponse(makeRes("max_output_tokens")).choices[0].finish_reason).toBe(
            "length",
        );
    });
});
