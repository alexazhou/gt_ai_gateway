import { describe, expect, it } from "vitest";
import upstreamFailureUtil from "../../../../src/util/protocol/upstreamFailureUtil";
import { ApiFormat } from "../../../../src/constants";


describe("upstreamFailureUtil.detectUpstreamBodyFailure", () => {
    describe("Responses", () => {
        it("flags status=failed and takes the code from error.code", () => {
            const body = JSON.stringify({
                id: "resp_1",
                object: "response",
                status: "failed",
                output: [],
                error: { code: "server_error", message: "upstream failed" },
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.RESPONSES, body)).toEqual({
                code: "server_error",
            });
        });

        it("flags a bare error event body {type:error,code,message}", () => {
            const body = JSON.stringify({ type: "error", code: "rate_limit_exceeded", message: "slow down" });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.RESPONSES, body)).toEqual({
                code: "rate_limit_exceeded",
            });
        });

        it("does not flag a completed response", () => {
            const body = JSON.stringify({
                id: "resp_1",
                object: "response",
                status: "completed",
                output: [],
                error: null,
                usage: { input_tokens: 3, output_tokens: 5 },
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.RESPONSES, body)).toBeNull();
        });

        it("does not flag status=incomplete (truncated but正常返回)", () => {
            const body = JSON.stringify({
                id: "resp_1",
                object: "response",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [],
                error: null,
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.RESPONSES, body)).toBeNull();
        });
    });


    describe("OpenAI", () => {
        it("flags an error body and takes the code from error.code", () => {
            const body = JSON.stringify({
                error: { message: "upstream unavailable", type: "server_error", code: "500" },
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.OPENAI, body)).toEqual({
                code: "500",
            });
        });

        it("falls back to error.type when there is no error.code", () => {
            const body = JSON.stringify({ error: { message: "nope", type: "invalid_request_error" } });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.OPENAI, body)).toEqual({
                code: "invalid_request_error",
            });
        });

        it("does not flag a normal chat completion", () => {
            const body = JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.OPENAI, body)).toBeNull();
        });

        it("does not flag a body carrying an explicit error:null", () => {
            const body = JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [],
                error: null,
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.OPENAI, body)).toBeNull();
        });
    });


    describe("Anthropic", () => {
        it("flags type=error and takes the code from error.type (no code field in该协议)", () => {
            const body = JSON.stringify({
                type: "error",
                error: { type: "overloaded_error", message: "Overloaded" },
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.ANTHROPIC, body)).toEqual({
                code: "overloaded_error",
            });
        });

        it("does not flag a normal message", () => {
            const body = JSON.stringify({
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "hi" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 3, output_tokens: 1 },
            });

            expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.ANTHROPIC, body)).toBeNull();
        });
    });


    it("does not flag a body that cannot be parsed as JSON", () => {
        expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.OPENAI, "<html>502</html>")).toBeNull();
        expect(upstreamFailureUtil.detectUpstreamBodyFailure(ApiFormat.RESPONSES, "")).toBeNull();
    });
});
