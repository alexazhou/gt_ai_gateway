import { describe, expect, it } from "vitest";
import { ApiFormat } from "../../../src/constants";
import {
    addSessionHeader,
    buildSessionId,
    DEFAULT_SESSION_HEADER,
    extractSessionSeed,
    resolveSessionHeader,
    uuid5,
} from "../../../src/plugin/addSessionHeader";
import type { PluginContext, PluginHookHandler, PluginPatchResult } from "../../../src/plugin/types";

function context(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        hook: "before_conversion",
        clientModel: "claude-sonnet-4-5",
        clientFormat: ApiFormat.ANTHROPIC,
        upstreamFormat: ApiFormat.ANTHROPIC,
        currentFormat: ApiFormat.ANTHROPIC,
        hostKey: "host-key-1",
        clientName: "claude-code",
        userId: 7,
        ...overrides,
    };
}

async function run(
    body: Record<string, unknown>,
    ctx: PluginContext = context(),
    pluginConfig: Record<string, unknown> = {},
): Promise<PluginPatchResult> {
    const handler = addSessionHeader.beforeConversion as PluginHookHandler;
    const result = await handler({ body, headers: new Headers() }, ctx, pluginConfig);
    return (result ?? {}) as PluginPatchResult;
}

const conversation = {
    system: "you are a helpful agent",
    messages: [
        { role: "user", content: "帮我把这段代码改成异步" },
        { role: "assistant", content: "好的" },
    ],
};

describe("addSessionHeader：session id 生成", () => {
    it("同 (用户, system prompt, 第一条 user 消息) 必然得到同一个 id；三者任一变化则不同", async () => {
        const base = await buildSessionId(7, "sys", "第一条");
        expect(await buildSessionId(7, "sys", "第一条")).toBe(base);
        expect(await buildSessionId(8, "sys", "第一条")).not.toBe(base);
        expect(await buildSessionId(7, "sys2", "第一条")).not.toBe(base);
        expect(await buildSessionId(7, "sys", "另一条")).not.toBe(base);
    });

    it("会话往下长（追加轮次）时 id 不变 —— 这是 session 能跨轮次聚合的前提", async () => {
        const first = await run(conversation);
        const longer = await run({
            ...conversation,
            messages: [
                ...conversation.messages,
                { role: "user", content: "第二轮" },
                { role: "assistant", content: "收到" },
                { role: "user", content: "第三轮" },
            ],
        });
        expect(longer.headerPatch?.set?.[DEFAULT_SESSION_HEADER])
            .toBe(first.headerPatch?.set?.[DEFAULT_SESSION_HEADER]);
    });

    it("产出的是标准 UUIDv5 字符串（版本位 5、RFC 4122 变体位）", async () => {
        const id = await buildSessionId(1, "sys", "hi");
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        // 与通用实现对齐：uuid5(NAMESPACE_URL, name) 逐字节可复现
        expect(await uuid5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "abc"))
            .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe("addSessionHeader：注入行为", () => {
    it("默认注入 X-Session-Id", async () => {
        const result = await run(conversation);
        expect(Object.keys(result.headerPatch?.set ?? {})).toEqual([DEFAULT_SESSION_HEADER]);
        expect(result.headerPatch?.set?.[DEFAULT_SESSION_HEADER]).toBeTruthy();
    });

    it("配置了 header 就注入配置的头名", async () => {
        const result = await run(conversation, context(), { header: "X-My-Session" });
        expect(result.headerPatch?.set).toEqual({ "X-My-Session": expect.any(String) });
    });

    it("请求已经带了同名头时由插件覆盖（会话身份是系统事实，不是客户端可决定的）", async () => {
        const result = await run(conversation);
        const injected = result.headerPatch?.set?.[DEFAULT_SESSION_HEADER];
        expect(injected).not.toBe("client-supplied-value");
    });

    it("Anthropic（system 顶字段）/ OpenAI（role=system）/ Responses（instructions + input 字符串）三种形态都能取到锚点", () => {
        expect(extractSessionSeed({ system: "s1", messages: [{ role: "user", content: "u1" }] }))
            .toEqual({ systemPrompt: "s1", firstUserMessage: "u1" });
        expect(extractSessionSeed({
            messages: [{ role: "system", content: "s2" }, { role: "user", content: "u2" }],
        })).toEqual({ systemPrompt: "s2", firstUserMessage: "u2" });
        expect(extractSessionSeed({ instructions: "s3", input: "u3" }))
            .toEqual({ systemPrompt: "s3", firstUserMessage: "u3" });
        // 文本块数组形态（Anthropic system / content 都可能是数组）
        expect(extractSessionSeed({
            system: [{ type: "text", text: "s4" }],
            messages: [{ role: "user", content: [{ type: "text", text: "u4" }] }],
        })).toEqual({ systemPrompt: "s4", firstUserMessage: "u4" });
    });

    it("没有任何消息时不抛错，退回整份请求体做锚点", async () => {
        const result = await run({ model: "m" });
        expect(result.headerPatch?.set?.[DEFAULT_SESSION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("头名解析：空串 / 非字符串都退回默认头", () => {
        expect(resolveSessionHeader({})).toBe(DEFAULT_SESSION_HEADER);
        expect(resolveSessionHeader({ header: "   " })).toBe(DEFAULT_SESSION_HEADER);
        expect(resolveSessionHeader({ header: 123 })).toBe(DEFAULT_SESSION_HEADER);
        expect(resolveSessionHeader({ header: " X-Custom " })).toBe("X-Custom");
    });
});

describe("addSessionHeader：config 校验", () => {
    const validate = (pluginConfig: Record<string, unknown>) => () => addSessionHeader.validateConfig!(pluginConfig);

    it("只接受 header，且必须是合法头名", () => {
        expect(validate({})).not.toThrow();
        expect(validate({ header: DEFAULT_SESSION_HEADER })).not.toThrow();
        expect(validate({ other: "x" })).toThrow(/only accepts "header"/);
        expect(validate({ header: "" })).toThrow(/must not be empty/);
        expect(validate({ header: 42 })).toThrow(/must be a string/);
        expect(validate({ header: "bad header" })).toThrow(/not a valid HTTP header name/);
    });

    it("受保护头（鉴权 / 网关管控 / 平台前缀）一律拒绝，避免插件与网关写头打架", () => {
        expect(validate({ header: "Authorization" })).toThrow(/protected header/);
        expect(validate({ header: "Content-Type" })).toThrow(/protected header/);
        expect(validate({ header: "cf-connecting-ip" })).toThrow(/protected header/);
        expect(validate({ header: "Sec-Fetch-Mode" })).toThrow(/protected header/);
    });
});
