import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import anthropicAccumulator from "../../../../src/util/accumulator/anthropicAccumulator";

function requireFixture(fileName: string): string {
    const logFile = join(__dirname, "..", "..", "..", "resource", "stream_logs", fileName);

    if (!existsSync(logFile)) {
        throw new Error(`Fixture not found: ${logFile}`);
    }

    return readFileSync(logFile, "utf-8");
}

function parseAnthropicStream(content: string) {
    const accumulator = new anthropicAccumulator.AnthropicAccumulator();
    const events = content.split("\n\n").filter((event) => event.trim());

    for (const event of events) {
        const lines = event.split("\n");
        let data = "";
        let eventType = "";

        for (const line of lines) {
            if (line.startsWith("data:")) {
                data = line.slice(5).trim();
            } else if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
            }
        }

        if (!data) continue;

        accumulator.addEvent({ data, event: eventType });
    }

    return accumulator.getResponse();
}

describe("AnthropicAccumulator fixtures", () => {
    it("parses anthropic non-tool stream fixture", () => {
        const response = parseAnthropicStream(requireFixture("anthropic-stream.log"));

        expect(response.model).toBe("glm-4.7");
        expect(response.choices).toHaveLength(1);
        expect(response.choices[0].message.role).toBe("assistant");
        expect(response.choices[0].message.content.length).toBeGreaterThan(0);
        expect(response.choices[0].message.thinking?.length).toBeGreaterThan(0);
        expect(response.choices[0].finish_reason).toBe("max_tokens");
        expect(response.usage?.prompt_tokens).toBe(6);
        expect(response.usage?.completion_tokens).toBe(223);
    });

    it("parses anthropic tool-use stream fixture", () => {
        const response = parseAnthropicStream(requireFixture("anthropic-tool-use-stream.log"));
        const toolUseList = response.choices[0].message.tool_use ?? [];
        const actualToolUse = toolUseList.find((item) => item?.name === "get_weather");

        expect(response.model).toBe("glm-4.7");
        expect(response.choices[0].message.role).toBe("assistant");
        expect(response.choices[0].finish_reason).toBe("tool_use");
        expect(actualToolUse).toBeDefined();
        expect(actualToolUse?.id).toBeTruthy();
        expect(actualToolUse?.input).toEqual({
            city: "上海",
            unit: "celsius",
        });
        expect(actualToolUse?.input_json).toBe(
            "{\"city\": \"上海\", \"unit\": \"celsius\"}",
        );
        expect(response.usage?.prompt_tokens).toBe(197);
        expect(response.usage?.completion_tokens).toBe(77);
    });
});

describe("AnthropicAccumulator stream state", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("marks completed on message_stop", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();
        acc.addEvent({ data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }), event: "content_block_delta" });
        acc.addEvent({ data: JSON.stringify({ type: "message_stop" }), event: "message_stop" });

        expect(acc.isCompleted()).toBe(true);
        expect(acc.isOutputStarted()).toBe(true);
    });

    it("captures cache_write_tokens from cache_creation_input_tokens", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();
        acc.addEvent({ data: JSON.stringify({
            type: "message_start",
            message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [],
                usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 80, cache_creation_input_tokens: 15 },
            },
        }), event: "message_start" });
        acc.addEvent({ data: JSON.stringify({ type: "message_stop" }), event: "message_stop" });

        const usage = acc.getUsage()!;
        // prompt_tokens 按总量口径 = 非缓存输入基数 + 缓存命中
        expect(usage.prompt_tokens).toBe(180);
        expect(usage.cache_read_tokens).toBe(80);
        expect(usage.cache_write_tokens).toBe(15);
    });

    it("does not parse the trailing [DONE] marker as JSON after message_stop (issue #14)", () => {
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
        const acc = new anthropicAccumulator.AnthropicAccumulator();

        // OpenRouter's direct Anthropic stream ends with these two SSE events.
        acc.addEvent({ data: JSON.stringify({ type: "message_stop" }), event: "message_stop" });
        acc.addEvent({ data: "[DONE]", event: "data" });

        expect(acc.isCompleted()).toBe(true);
        expect(consoleLog).not.toHaveBeenCalledWith(
            "Failed to parse SSE data:",
            "[DONE]",
            expect.any(SyntaxError),
        );
    });

    it("marks completed when an Anthropic-compatible upstream only sends [DONE]", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();

        acc.addEvent({ data: "[DONE]", event: "data" });

        expect(acc.isCompleted()).toBe(true);
    });

    it("does not mark completed when [DONE] follows an upstream error", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();
        acc.addEvent({ data: JSON.stringify({ type: "error", error: { message: "rate limited" } }), event: "error" });

        acc.addEvent({ data: "[DONE]", event: "data" });

        expect(acc.isErrored()).toBe(true);
        expect(acc.isCompleted()).toBe(false);
    });

    it("flags output started on lifecycle events (preserves TTFT semantics)", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();
        acc.addEvent({ data: JSON.stringify({ type: "message_start", message: { id: "m1", model: "claude" } }), event: "message_start" });

        // message_start 是非完成/非错误事件，按现行 TTFT 语义计为 outputStarted
        expect(acc.isOutputStarted()).toBe(true);
        expect(acc.isCompleted()).toBe(false);
    });

    it("marks errored on error event", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();
        acc.addEvent({ data: JSON.stringify({ type: "error", error: { message: "rate limited" } }), event: "error" });

        expect(acc.isErrored()).toBe(true);
        expect(acc.isCompleted()).toBe(false);
    });

    it("reset clears all state", () => {
        const acc = new anthropicAccumulator.AnthropicAccumulator();
        acc.addEvent({ data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }), event: "content_block_delta" });
        acc.addEvent({ data: JSON.stringify({ type: "message_stop" }), event: "message_stop" });
        acc.reset();

        expect(acc.isCompleted()).toBe(false);
        expect(acc.isOutputStarted()).toBe(false);
        expect(acc.isErrored()).toBe(false);
        expect(acc.getError()).toBeNull();
        expect(acc.getResponse().choices[0].message.content).toBe("");
    });
});
