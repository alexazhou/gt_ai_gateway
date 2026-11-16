/**
 * protocolConverter 基础转换器与工厂单元测试
 */

import { describe, it, expect } from "vitest";
import { AnthropicToOpenAIConverter } from "../../../src/util/protocolConverter/AnthropicToOpenAIConverter";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ResponsesToAnthropicConverter } from "../../../src/util/protocolConverter/ResponsesToAnthropicConverter";
import { AnthropicToResponsesConverter } from "../../../src/util/protocolConverter/AnthropicToResponsesConverter";
import { BaseConverter } from "../../../src/util/protocolConverter/BaseConverter";
import { ApiFormat } from "../../../src/constants";
import customError from "../../../src/customError";
import type {
    AnthropicContentBlock,
    AnthropicRequest,
    AnthropicResponse,
} from "../../../src/util/protocol/anthropicTypes";
import type { ProtocolStreamEvent } from "../../../src/util/protocol/commonTypes";
import type { OpenAIResponse } from "../../../src/util/protocol/openaiTypes";
import protocolConverterTestUtil from "./protocolConverterTestUtil";
import type {
    ResponsesContentPart,
    ResponsesMessageItem,
    ResponsesNonStreamResponse,
    ResponsesOutputMessage,
    ResponsesRequest,
} from "../../../src/util/protocol/responsesTypes";

class TestConverter extends BaseConverter {
    constructor(private shouldThrow: "none" | "error" | "appError" = "none") {
        super("test-model", "test-response-id");
    }

    public convertRequest(clientReq: unknown): unknown {
        if (this.shouldThrow === "error") {
            throw new Error("boom");
        }
        if (this.shouldThrow === "appError") {
            throw new customError.AppError("custom boom", 422);
        }
        return { converted: (clientReq as { value?: unknown }).value };
    }

    public convertResponse(upstreamRes: unknown): unknown {
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

        const eventData = protocolConverterTestUtil.parseStreamEventData(converter.convertStreamEvent(JSON.stringify({ value: "hello" })));
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
        }) as AnthropicRequest;
        // P1-07：缺省值改为安全缺省 4096
        expect(upstreamRequest.max_tokens).toBe(4096);
        // #295：工厂链路同样经过收尾补全 —— 最后一条 user 规范化为带标记的 text 块
        expect(upstreamRequest.messages[0].content).toEqual([
            { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
        ]);

        const clientResponse = converter!.convertResponse({
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hi" }],
            model: "claude-3-haiku-20240307",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
        }) as OpenAIResponse;
        expect(clientResponse.object).toBe("chat.completion");
        expect(clientResponse.choices[0].message.content).toBe("Hi");
    });
});


// 原在 ResponsesConverterFactory.test.ts，与 baseAndFactory.test.ts 的同主题工厂路由用例合并；
// 其中「should create client-to-server converter for RESPONSES -> ANTHROPIC」与上面第一条断言
// 完全相同，合并时去掉了一条。
describe("ConverterFactory - Responses ↔ Anthropic routing", () => {
    it("should create ResponsesToAnthropicConverter for RESPONSES → ANTHROPIC", () => {
        const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        expect(converter).toBeInstanceOf(ResponsesToAnthropicConverter);
    });

    it("should create AnthropicToResponsesConverter for ANTHROPIC → RESPONSES", () => {
        const converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES);
        expect(converter).toBeInstanceOf(AnthropicToResponsesConverter);
    });

    it("should return null for same format", () => {
        expect(ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.RESPONSES)).toBeNull();
    });

    it("should convert Anthropic client requests and Responses upstream responses through one converter", () => {
        const converter = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.RESPONSES);
        expect(converter).toBeInstanceOf(AnthropicToResponsesConverter);

        const upstreamReq = converter!.convertRequest({
            model: "gpt-5.5",
            max_tokens: 1024,
            messages: [{ role: "user", content: "你好" }],
        }) as ResponsesRequest;
        const firstItem = upstreamReq.input[0] as ResponsesMessageItem;
        expect((firstItem.content as ResponsesContentPart[])[0].type).toBe("input_text");

        const clientRes = converter!.convertResponse({
            id: "resp_123",
            object: "response",
            created_at: 1677652288,
            status: "completed",
            model: "ppio/pa/gpt-5.5",
            output: [
                {
                    type: "message",
                    id: "msg_0",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "你好！" }],
                },
            ],
            usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens: 2,
                total_tokens: 12,
            },
        }) as AnthropicResponse;

        expect(clientRes.type).toBe("message");
        expect(clientRes.content[0]).toEqual({ type: "text", text: "你好！" });
        expect(clientRes.usage).toEqual({ input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4 });
    });

    it("should convert Responses client requests and Anthropic upstream responses through one converter", () => {
        const converter = ConverterFactory.create(ApiFormat.RESPONSES, ApiFormat.ANTHROPIC);
        expect(converter).toBeInstanceOf(ResponsesToAnthropicConverter);

        const upstreamReq = converter!.convertRequest({
            model: "claude-3-sonnet-20240229",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hello" }],
                },
            ],
        }) as AnthropicRequest;
        // #295：Responses 路由也经过同一个收尾补全 —— 文本逐字一致、最后一块带标记
        expect((upstreamReq.messages[0].content as AnthropicContentBlock[])[0]).toEqual({
            type: "text",
            text: "hello",
            cache_control: { type: "ephemeral" },
        });

        const clientRes = converter!.convertResponse({
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello!" }],
            model: "claude-3-sonnet-20240229",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
        }) as ResponsesNonStreamResponse;

        expect(clientRes.object).toBe("response");
        expect(clientRes.output[0].type).toBe("message");
        const outputItem = clientRes.output[0] as ResponsesOutputMessage;
        expect(outputItem.content[0].text).toBe("Hello!");
    });

    it("should still create Anthropic ↔ OpenAI converters", () => {
        const a2o = ConverterFactory.create(ApiFormat.ANTHROPIC, ApiFormat.OPENAI);
        const o2a = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC);
        expect(a2o).not.toBeNull();
        expect(o2a).not.toBeNull();
    });
});
