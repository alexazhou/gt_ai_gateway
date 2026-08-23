import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import openaiChatAccumulator from "../../../../src/util/accumulator/openaiChatAccumulator";

function requireFixture(fileName: string): string {
    const logFile = join(__dirname, "..", "..", "..", "resource", "stream_logs", fileName);

    if (!existsSync(logFile)) {
        throw new Error(`Fixture not found: ${logFile}`);
    }

    return readFileSync(logFile, "utf-8");
}

function parseOpenAIStream(content: string) {
    const accumulator = new openaiChatAccumulator.OpenAIChatAccumulator();
    const events = content.split("\n\n").filter((event) => event.trim());

    for (const event of events) {
        const dataMatch = event.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        accumulator.addEvent({ data: dataMatch[1] });
    }

    return accumulator.getResponse();
}

describe("OpenAIChatAccumulator fixtures", () => {
    it("parses openai non-tool stream fixture", () => {
        const response = parseOpenAIStream(requireFixture("openai-stream.log"));

        expect(response.object).toBe("chat.completion.chunk");
        expect(response.model).toBe("gpt-3.5-turbo");
        expect(response.choices).toHaveLength(1);
        expect(response.choices[0].message.role).toBe("assistant");
        expect(response.choices[0].message.content).toBe(
            "Hello! I am a mock AI assistant. How can I help you?",
        );
        expect(response.choices[0].finish_reason).toBe("stop");
        expect(response.usage?.prompt_tokens).toBe(8);
        expect(response.usage?.completion_tokens).toBe(12);
    });

    it("parses openai tool-call stream fixture", () => {
        const response = parseOpenAIStream(requireFixture("openai-tool-call-stream.log"));
        const toolCalls = response.choices[0].message.tool_calls ?? [];

        expect(response.object).toBe("chat.completion.chunk");
        expect(response.model).toBe("glm-4.7");
        expect(response.choices[0].message.role).toBe("assistant");
        expect(response.choices[0].finish_reason).toBe("tool_calls");
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].type).toBe("function");
        expect(toolCalls[0].function.name).toBe("get_weather");
        expect(toolCalls[0].function.arguments).toBe(
            "{\"city\": \"上海\", \"unit\": \"celsius\"}",
        );
        expect(toolCalls[0].id).toBeTruthy();
        expect(response.usage?.prompt_tokens).toBe(197);
        expect(response.usage?.completion_tokens).toBe(76);
    });

    it("parses openai reasoning stream fixture", () => {
        const response = parseOpenAIStream(requireFixture("openai-reasoning-stream.log"));

        expect(response.object).toBe("chat.completion.chunk");
        expect(response.model).toBe("qwen3.6-plus");
        expect(response.choices).toHaveLength(1);
        expect(response.choices[0].message.role).toBe("assistant");
        expect(response.choices[0].message.reasoning_content?.length).toBeGreaterThan(0);
        expect(response.choices[0].message.content.length).toBeGreaterThan(0);
        expect(response.choices[0].finish_reason).toBe("stop");
        expect(response.usage?.completion_tokens_details?.reasoning_tokens).toBeGreaterThan(0);
    });
});

describe("OpenAIChatAccumulator stream state", () => {
    it("marks completed on [DONE]", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        acc.addEvent({ data: JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) });
        acc.addEvent({ data: "[DONE]" });

        expect(acc.isCompleted()).toBe(true);
        expect(acc.isOutputStarted()).toBe(true);
        expect(acc.isErrored()).toBe(false);
    });

    it("marks errored on error event", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        acc.addEvent({ data: JSON.stringify({ type: "error", error: { message: "rate limited" } }) });

        expect(acc.isErrored()).toBe(true);
        expect(acc.isCompleted()).toBe(false);
        expect(acc.getError()).toMatchObject({ type: "error" });
    });

    it("getUsage returns accumulated usage", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        acc.addEvent({ data: JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) });

        expect(acc.getUsage()?.prompt_tokens).toBe(5);
        expect(acc.getUsage()?.completion_tokens).toBe(3);
    });

    it("captures cache_read_tokens and cache_write_tokens from prompt_tokens_details", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        acc.addEvent({ data: JSON.stringify({
            choices: [],
            usage: {
                prompt_tokens: 71617,
                completion_tokens: 128,
                total_tokens: 71745,
                prompt_tokens_details: { cached_tokens: 71168, cache_write_tokens: 1234 },
            },
        }) });

        const usage = acc.getUsage()!;
        expect(usage.cache_read_tokens).toBe(71168);
        expect(usage.cache_write_tokens).toBe(1234);
    });

    it("marks parse failure on invalid JSON payloads", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        acc.addEvent({ data: "this is not json" });

        expect(acc.isCompleted()).toBe(false);
        expect(acc.isErrored()).toBe(true);
        expect(acc.isParseFailed()).toBe(true);
        expect(acc.isOutputStarted()).toBe(false);
        expect(acc.getError()).toBeNull();
    });

    it("accumulates legacy function_call name and arguments across chunks", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        acc.addEvent({ data: JSON.stringify({ choices: [{ index: 0, delta: { function_call: { name: "get_weather", arguments: "{\"city\":" } }, finish_reason: null }] }) });
        acc.addEvent({ data: JSON.stringify({ choices: [{ index: 0, delta: { function_call: { arguments: " \"beijing\"}" } }, finish_reason: null }] }) });

        expect(acc.getResponse().choices[0].message.function_call).toEqual({
            name: "get_weather",
            arguments: "{\"city\": \"beijing\"}",
        });
    });

    it("reset clears all state", () => {
        const acc = new openaiChatAccumulator.OpenAIChatAccumulator();
        acc.addEvent({ data: JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) });
        acc.addEvent({ data: "[DONE]" });
        acc.reset();

        expect(acc.isCompleted()).toBe(false);
        expect(acc.isOutputStarted()).toBe(false);
        expect(acc.isErrored()).toBe(false);
        expect(acc.getError()).toBeNull();
        expect(acc.getResponse().choices[0].message.content).toBe("");
    });
});
