/**
 * P1-07 验收门：OpenAI → Anthropic 的 `max_tokens` 缺省值与 tool_choice / response_format 组合。
 *
 * 现状（修复前）：`max_tokens: clientReq.max_tokens || clientReq.max_completion_tokens || 32768`。
 * 32768 这个缺省值是「硬顶」而不是「安全缺省」：
 * - 很多 Anthropic 线上模型（尤其带思考的型号）单次输出上限低于 32768，用缺省值直接打过去
 *   会收到 400 `max_tokens: too large`，客户端什么都没干就被拒；
 * - 而 OpenAI 侧本来允许不传 `max_tokens`（普通 chat 请求里非常常见），所以这条路不是边缘场景。
 *
 * 修复方向：未传时取安全缺省（或按 vendor_model 上限钳制），并要求显式传值时原样透传。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import { ConverterFactory } from "../../../src/util/protocolConverter/ConverterFactory";
import { ApiFormat } from "../../../src/constants";
import type { AnthropicRequest } from "../../../src/util/protocol/anthropicTypes";
import type { OpenAIRequest } from "../../../src/util/protocol/openaiTypes";

/** Anthropic 侧当前所有模型都接受的输出上限（安全缺省必须落在这一档以内） */
const SAFE_MAX_TOKENS_UPPER_BOUND = 8192;

describe("OpenAIToAnthropicConverter - max_tokens 缺省（P1-07）", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    const baseRequest = (overrides: Partial<OpenAIRequest> = {}): OpenAIRequest => ({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
        ...overrides,
    });

    it("未传 max_tokens 时取安全缺省，不能用 32768 这类硬顶", () => {
        const result = converter.convertRequest(baseRequest()) as AnthropicRequest;

        expect(result.max_tokens).toBeGreaterThan(0);
        expect(
            result.max_tokens,
            `未传 max_tokens 时缺省值 ${result.max_tokens} 超过安全档 ${SAFE_MAX_TOKENS_UPPER_BOUND}，低上限模型会直接 400`,
        ).toBeLessThanOrEqual(SAFE_MAX_TOKENS_UPPER_BOUND);
    });

    it("显式 max_tokens 原样透传（不因为是「小值」被抬到缺省）", () => {
        const result = converter.convertRequest(baseRequest({ max_tokens: 128 })) as AnthropicRequest;

        expect(result.max_tokens).toBe(128);
    });

    it("只传 max_completion_tokens（OpenAI 新字段）时按它取值", () => {
        const result = converter.convertRequest(
            baseRequest({ max_completion_tokens: 256 } as Partial<OpenAIRequest>),
        ) as AnthropicRequest;

        expect(result.max_tokens).toBe(256);
    });

    it("max_tokens=0 / 负数等非法值回落到安全缺省", () => {
        for (const invalid of [0, -1]) {
            const result = converter.convertRequest(baseRequest({ max_tokens: invalid })) as AnthropicRequest;
            expect(result.max_tokens).toBeGreaterThan(0);
            expect(result.max_tokens).toBeLessThanOrEqual(SAFE_MAX_TOKENS_UPPER_BOUND);
        }
    });
});

describe("OpenAIToAnthropicConverter - tool_choice / response_format 组合（P1-07）", () => {
    let converter: OpenAIToAnthropicConverter;

    beforeEach(() => {
        converter = ConverterFactory.create(ApiFormat.OPENAI, ApiFormat.ANTHROPIC) as OpenAIToAnthropicConverter;
    });

    const tools: OpenAIRequest["tools"] = [
        {
            type: "function",
            function: {
                name: "get_weather",
                description: "get weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
            },
        },
    ];

    it("省略 max_tokens + tool_choice=required + response_format 组合时，转换不炸且各字段都到位", () => {
        const request = {
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "weather in SH?" }],
            tools,
            tool_choice: "required",
            response_format: { type: "json_object" },
        } as unknown as OpenAIRequest;

        const result = converter.convertRequest(request) as AnthropicRequest;

        // max_tokens 仍必须是安全缺省（缺省逻辑不能被组合字段绕过）
        expect(result.max_tokens).toBeGreaterThan(0);
        expect(result.max_tokens).toBeLessThanOrEqual(SAFE_MAX_TOKENS_UPPER_BOUND);
        // tools 与 tool_choice 都要转换到 Anthropic 口径
        expect(result.tools, "tools 必须转换").toHaveLength(1);
        expect(result.tools?.[0].name).toBe("get_weather");
        expect(result.tool_choice).toEqual({ type: "any" });
    });

    it("tool_choice 为对象时映射成具体工具；为 none 时不带 tool_choice", () => {
        const withTool = converter.convertRequest({
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "hi" }],
            tools,
            tool_choice: { type: "function", function: { name: "get_weather" } },
        } as unknown as OpenAIRequest) as AnthropicRequest;
        expect(withTool.tool_choice).toEqual({ type: "tool", name: "get_weather" });

        const none = converter.convertRequest({
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "hi" }],
            tools,
            tool_choice: "none",
        } as unknown as OpenAIRequest) as AnthropicRequest;
        expect(none.tool_choice).toBeUndefined();
    });

    it("response_format=json_schema 时不会污染 messages（内容原样保留）", () => {
        const request = {
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "return json" }],
            response_format: {
                type: "json_schema",
                json_schema: { name: "out", schema: { type: "object", properties: {} } },
            },
        } as unknown as OpenAIRequest;

        const result = converter.convertRequest(request) as AnthropicRequest;

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toBe("return json");
        expect(result.max_tokens).toBeLessThanOrEqual(SAFE_MAX_TOKENS_UPPER_BOUND);
    });
});
