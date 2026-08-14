/**
 * protocolConverter 基础转换器与工厂单元测试
 */

import { describe, it, expect } from "vitest";
import { AnthropicToOpenAIConverter } from "../../../src/util/protocolConverter/AnthropicToOpenAIConverter";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { BaseConverter } from "../../../src/util/protocolConverter/BaseConverter";
import { ApiFormat } from "../../../src/constants";
import customError from "../../../src/util/customErrorUtil";
import type { ProtocolStreamEvent } from "../../../src/util/protocolConverter/protocolTypes";

function parseStreamEventData(events: ProtocolStreamEvent[], index: number = 0): any {
    return JSON.parse(events[index].data);
}

class TestConverter extends BaseConverter {
    constructor(private shouldThrow: "none" | "error" | "appError" = "none") {
        super("test-model", "test-response-id");
    }

    public convertRequest(clientReq: any): any {
        if (this.shouldThrow === "error") {
            throw new Error("boom");
        }
        if (this.shouldThrow === "appError") {
            throw new customError.AppError("custom boom", 422);
        }
        return { converted: clientReq.value };
    }

    public convertResponse(upstreamRes: any): any {
        return upstreamRes;
    }

    protected doConvertStreamEvent(data: Record<string, unknown>): ProtocolStreamEvent[] {
        return [{ data: JSON.stringify({ converted: data.value, model: this.requestModel, id: this.responseId }) }];
    }
}

describe("BaseConverter", () => {
    it("should convert request body JSON strings", () => {
        const converter = new TestConverter();
        const result = JSON.parse(converter.convertRequestBody(JSON.stringify({ value: "hello" })));

        expect(result).toEqual({ converted: "hello" });
    });

    it("should throw AppError for invalid request JSON", () => {
        const converter = new TestConverter();

        expect(() => converter.convertRequestBody("{ not json }")).toThrow(customError.AppError);
        try {
            converter.convertRequestBody("{ not json }");
        } catch (e: any) {
            expect(e.statusCode).toBe(400);
            expect(e.message).toContain("invalid JSON");
        }
    });

    it("should wrap generic conversion errors as AppError", () => {
        const converter = new TestConverter("error");

        try {
            converter.convertRequestBody(JSON.stringify({ value: "hello" }));
            expect.fail("Expected conversion to throw");
        } catch (e: any) {
            expect(e).toBeInstanceOf(customError.AppError);
            expect(e.statusCode).toBe(400);
            expect(e.message).toContain("boom");
        }
    });

    it("should preserve AppError thrown by concrete converter", () => {
        const converter = new TestConverter("appError");

        try {
            converter.convertRequestBody(JSON.stringify({ value: "hello" }));
            expect.fail("Expected conversion to throw");
        } catch (e: any) {
            expect(e).toBeInstanceOf(customError.AppError);
            expect(e.statusCode).toBe(422);
            expect(e.message).toBe("custom boom");
        }
    });

    it("should pass through invalid stream JSON with event metadata", () => {
        const converter = new TestConverter();
        const events = converter.convertStreamEvent("not-json", "ping", "evt-1");

        expect(events).toEqual([{ data: "not-json", event: "ping", id: "evt-1" }]);
    });

    it("should skip DONE by default", () => {
        const converter = new TestConverter();

        expect(converter.convertStreamEvent("[DONE]")).toEqual([]);
    });

    it("should use updated model and response id in stream conversion", () => {
        const converter = new TestConverter();
        converter.updateModel("updated-model");
        converter.updateResponseId("updated-id");

        const eventData = parseStreamEventData(converter.convertStreamEvent(JSON.stringify({ value: "hello" })));
        expect(eventData).toEqual({
            converted: "hello",
            model: "updated-model",
            id: "updated-id",
        });
    });
});

describe("ConverterFactory", () => {
    it("should return null when formats match", () => {
        expect(ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.OPENAI)).toBeNull();
    });

    it("should create supported converters", () => {
        expect(ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI)).toBeInstanceOf(AnthropicToOpenAIConverter);
        expect(ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC)).toBeInstanceOf(OpenAIToAnthropicConverter);
    });

    it("should return null for unsupported conversions", () => {
        expect(ConverterFactory.create("google" as ApiFormat, ApiFormat.OPENAI)).toBeNull();
    });

    it("should create a client-to-server converter for request and response conversion", () => {
        const converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC);

        expect(converter).toBeInstanceOf(OpenAIToAnthropicConverter);

        const upstreamRequest = converter!.convertRequest({
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
        });
        expect(upstreamRequest.max_tokens).toBe(32768);
        expect(upstreamRequest.messages[0].content).toBe("Hello");

        const clientResponse = converter!.convertResponse({
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hi" }],
            model: "claude-3-haiku-20240307",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
        });
        expect(clientResponse.object).toBe("chat.completion");
        expect(clientResponse.choices[0].message.content).toBe("Hi");
    });
});
