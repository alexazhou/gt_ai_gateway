import { describe, it, expect } from "vitest";
import { ResponsesToOpenAIConverter } from "../../../src/util/protocolConverter/ResponsesToOpenAIConverter";

/**
 * Responses 客户端 → OpenAI 上游：请求映射的边缘形态。
 *
 * 这一侧最容易错的是「历史消息的方向」——`function_call` 是 assistant 的 tool_calls、
 * `function_call_output` 是 tool 消息，弄反了上游会把它当成用户说的话。
 */
describe("ResponsesToOpenAIConverter：请求映射边缘路径", () => {
    const conv = (): ResponsesToOpenAIConverter => new ResponsesToOpenAIConverter("gpt-4");
    const make = (patch: Record<string, unknown>) =>
        ({ model: "gpt-4", input: [], ...patch }) as any;

    it("tool_choice:none 与 reasoning.effort 原样映射到 OpenAI 字段", () => {
        const result = conv().convertRequest(
            make({
                input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
                tool_choice: "none",
                reasoning: { effort: "medium" },
            }),
        );

        expect(result.tool_choice).toBe("none");
        expect(result.reasoning_effort).toBe("medium");
    });

    it("function_call 输入项 → assistant 消息的 tool_calls（不是用户消息）", () => {
        const result = conv().convertRequest(
            make({
                input: [
                    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SH"}' },
                ],
            }),
        );

        const assistantWithToolCalls = result.messages.find(
            (m: any) => m.role === "assistant" && Array.isArray(m.tool_calls),
        );
        expect(assistantWithToolCalls).toBeDefined();
        expect(assistantWithToolCalls!.tool_calls![0]).toMatchObject({
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SH"}' },
        });
    });

    it("function_call_output 输入项 → tool 消息（带 tool_call_id，方向不弄反）", () => {
        const result = conv().convertRequest(
            make({
                input: [{ type: "function_call_output", call_id: "call_1", output: "晴 25℃" }],
            }),
        );

        const toolMsg = result.messages.find((m: any) => m.role === "tool");
        expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "晴 25℃" });
    });

    it("input_image 只有 file_id 没有 url → 400（不做静默丢弃）", () => {
        const req = make({
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_image", file_id: "file-1" }],
                },
            ],
        });

        expect(() => conv().convertRequest(req)).toThrowError(/file_id cannot be converted/);
    });

    it("content_part.added 之外：字符串 content 的消息直通", () => {
        const result = conv().convertRequest(
            make({
                input: [
                    { type: "message", role: "user", content: "纯文本" },
                ],
            }),
        );

        expect(result.messages[0]).toEqual({ role: "user", content: "纯文本" });
    });

    it("上游 finish_reason=content_filter → 终止事件带 status=incomplete(content_filter)", () => {
        const c = conv();
        const evts = c.convertStreamEvent(
            JSON.stringify({
                id: "chatcmpl-1",
                model: "gpt-4",
                choices: [{ index: 0, delta: { content: "半句" }, finish_reason: "content_filter" }],
            }),
            undefined,
        );
        const all = [...evts, ...c.onUpstreamEnd()]
            .map((e) => {
                try {
                    return JSON.parse(e.data);
                } catch {
                    return null;
                }
            })
            .filter((d) => d?.response?.status);

        const incomplete = all.find((d) => d.response.status === "incomplete");
        expect(incomplete).toBeDefined();
        expect(incomplete.response.incomplete_details).toEqual({ reason: "content_filter" });
    });
});
