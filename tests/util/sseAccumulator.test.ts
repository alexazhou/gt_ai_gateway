import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import sseAccumulator from "../../src/util/sseAccumulator";

function requireFixture(fileName: string): string {
    const logFile = join(__dirname, "..", "resource", fileName);

    if (!existsSync(logFile)) {
        throw new Error(`Fixture not found: ${logFile}`);
    }

    return readFileSync(logFile, "utf-8");
}

function parseOpenAIStream(content: string) {
    const accumulator = new sseAccumulator.SSEAccumulator("openai");
    const events = content.split("\n\n").filter((event) => event.trim());

    for (const event of events) {
        const dataMatch = event.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        const data = dataMatch[1];
        if (data === "[DONE]") continue;

        accumulator.addMessage(JSON.parse(data));
    }

    return accumulator.getResponse();
}

function parseAnthropicStream(content: string) {
    const accumulator = new sseAccumulator.SSEAccumulator("anthropic");
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

        if (!data || data === "[DONE]") continue;

        accumulator.addMessage(JSON.parse(data), eventType);
    }

    return accumulator.getResponse();
}

describe("SSE Accumulator Fixtures", () => {
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
        expect(response.usage).toEqual({
            prompt_tokens: 8,
            completion_tokens: 12,
            total_tokens: 20,
        });
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
        expect(response.usage?.total_tokens).toBe(229);
    });

    it("parses anthropic tool-use stream fixture", () => {
        const response = parseAnthropicStream(requireFixture("anthropic-tool-use-stream.log"));
        const toolUseList = response.choices[0].message.tool_use ?? [];
        const actualToolUse = toolUseList.find((item) => item?.name === "get_weather");

        expect(response.model).toBe("glm-4.7");
        expect(response.choices[0].message.role).toBe("assistant");
        expect(response.choices[0].message.thinking?.length).toBeGreaterThan(0);
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
        expect(response.usage?.total_tokens).toBe(274);
    });
});
