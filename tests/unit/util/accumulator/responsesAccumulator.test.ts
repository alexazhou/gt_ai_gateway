import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import responsesAccumulator from "../../../../src/util/accumulator/responsesAccumulator";

function requireFixture(fileName: string): string {
    const logFile = join(__dirname, "..", "..", "..", "resource", "stream_logs", fileName);

    if (!existsSync(logFile)) {
        throw new Error(`Fixture not found: ${logFile}`);
    }

    return readFileSync(logFile, "utf-8");
}

function parseResponsesStream(content: string) {
    const accumulator = new responsesAccumulator.ResponsesAccumulator();
    const lines = content.split("\n").filter((line) => line.startsWith("data:"));

    for (const line of lines) {
        const data = line.slice(5).trim();
        if (!data) continue;

        accumulator.addEvent({ data });
    }

    return accumulator;
}

describe("ResponsesAccumulator", () => {
    describe("fixture: responses-stream.log", () => {
        it("parses response id and model", () => {
            const acc = parseResponsesStream(requireFixture("responses-stream.log"));
            const response = acc.getResponse();

            expect(response.id).toBe("resp_abc123");
            expect(response.model).toBe("gpt-4o");
            expect(response.object).toBe("response");
        });

        it("parses response status as completed", () => {
            const acc = parseResponsesStream(requireFixture("responses-stream.log"));
            const response = acc.getResponse();

            expect(response.status).toBe("completed");
            expect(acc.isCompleted()).toBe(true);
        });

        it("parses output text content", () => {
            const acc = parseResponsesStream(requireFixture("responses-stream.log"));
            const response = acc.getResponse();

            expect(response.output).toHaveLength(1);
            expect(response.output[0].role).toBe("assistant");
            expect(response.output[0].content).toHaveLength(1);
            expect(response.output[0].content[0].type).toBe("output_text");
            expect(response.output[0].content[0].text).toBe("Hello! How can I help you?");
        });

        it("parses usage tokens (normalized to canonical keys)", () => {
            const acc = parseResponsesStream(requireFixture("responses-stream.log"));
            const response = acc.getResponse();

            expect(response.usage?.prompt_tokens).toBe(10);
            expect(response.usage?.completion_tokens).toBe(8);
            expect(response.usage?.cache_read_tokens).toBe(0);
            expect(acc.getUsage()).toEqual(response.usage);
        });

        it("getText() returns plain text of first output item", () => {
            const acc = parseResponsesStream(requireFixture("responses-stream.log"));
            expect(acc.getText()).toBe("Hello! How can I help you?");
        });
    });

    describe("incremental text accumulation", () => {
        it("accumulates delta text before response.completed arrives", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();

            acc.addEvent({ data: JSON.stringify({ type: "response.created", response: { id: "r1", model: "gpt-4o", object: "response", status: "in_progress" } }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "m1", type: "message", role: "assistant", status: "in_progress" } }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: " world" }) });

            // response.completed 还未到达，getText() 已可使用
            expect(acc.getText()).toBe("Hello world");
        });

        it("output_text.done overwrites incremental text", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();

            acc.addEvent({ data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { role: "assistant" } }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partia" }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "l" }) });
            // done 事件携带权威完整文本
            acc.addEvent({ data: JSON.stringify({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "partial" }) });

            expect(acc.getResponse().output[0].content[0].text).toBe("partial");
        });
    });

    describe("stream state", () => {
        it("marks stream completed on response.completed", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();

            acc.addEvent({
                data: JSON.stringify({
                    type: "response.completed",
                    response: {
                        id: "r1",
                        object: "response",
                        status: "completed",
                        output: [],
                        usage: {
                            input_tokens: 2,
                            output_tokens: 3,
                            total_tokens: 5,
                        },
                    },
                }),
            });

            expect(acc.isCompleted()).toBe(true);
            expect(acc.isErrored()).toBe(false);
            expect(acc.getUsage()).toEqual({
                prompt_tokens: 2,
                completion_tokens: 3,
                // 上游未返回缓存 → null（区别于返回 0）
                cache_read_tokens: null,
            });
        });

        it("marks event:error payload as errored", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();
            const errorPayload = {
                type: "error",
                error: {
                    type: "rate_limit_error",
                    code: "1302",
                    message: "rate limited",
                },
            };

            acc.addEvent({ data: JSON.stringify(errorPayload), event: "error" });

            expect(acc.isCompleted()).toBe(false);
            expect(acc.isErrored()).toBe(true);
            expect(acc.getError()).toEqual(errorPayload);
        });

        it("marks response.failed as errored", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();
            const failedPayload = {
                type: "response.failed",
                response: {
                    id: "r1",
                    status: "failed",
                    error: {
                        code: "server_error",
                        message: "upstream failed",
                    },
                },
            };

            acc.addEvent({ data: JSON.stringify(failedPayload) });

            expect(acc.isErrored()).toBe(true);
            expect(acc.getError()).toEqual(failedPayload);
        });

        it("does not flag output started on lifecycle events", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();

            acc.addEvent({ data: JSON.stringify({ type: "response.created", response: { id: "r1", model: "gpt-4o" } }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.in_progress" }) });

            expect(acc.isOutputStarted()).toBe(false);
        });

        it("flags output started on text delta", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();

            acc.addEvent({ data: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi" }) });

            expect(acc.isOutputStarted()).toBe(true);
        });

        it("flags output started on function call and reasoning deltas", () => {
            const acc1 = new responsesAccumulator.ResponsesAccumulator();
            acc1.addEvent({ data: JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{" }) });
            expect(acc1.isOutputStarted()).toBe(true);

            const acc2 = new responsesAccumulator.ResponsesAccumulator();
            acc2.addEvent({ data: JSON.stringify({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thinking" }) });
            expect(acc2.isOutputStarted()).toBe(true);

            const acc3 = new responsesAccumulator.ResponsesAccumulator();
            acc3.addEvent({ data: JSON.stringify({ type: "response.reasoning_summary_part.added", output_index: 0 }) });
            expect(acc3.isOutputStarted()).toBe(true);
        });

        it("flags output started on output_item.added", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();

            acc.addEvent({ data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } }) });

            expect(acc.isOutputStarted()).toBe(true);
        });
    });

    describe("reset()", () => {
        it("clears all accumulated state", () => {
            const acc = new responsesAccumulator.ResponsesAccumulator();

            acc.addEvent({ data: JSON.stringify({ type: "response.created", response: { id: "r1", model: "gpt-4o" } }) });
            acc.addEvent({ data: JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi" }) });
            acc.addEvent({ data: JSON.stringify({ type: "error", error: { message: "failed" } }), event: "error" });
            acc.reset();

            const response = acc.getResponse();
            expect(response.id).toBeUndefined();
            expect(response.model).toBeUndefined();
            expect(response.output).toHaveLength(0);
            expect(acc.isCompleted()).toBe(false);
            expect(acc.isErrored()).toBe(false);
            expect(acc.isOutputStarted()).toBe(false);
            expect(acc.getError()).toBeNull();
        });
    });
});
