import { describe, expect, it, vi } from "vitest";
import { ApiFormat } from "../../../src/constants";
import { cchRewriter, planCchRewrite, rewriteCchInSystemPrompt } from "../../../src/plugin/cchRewriter";
import { claudeCodeTrackingRewriter, planTrackingMarkerRemoval } from "../../../src/plugin/claudeCodeTrackingRewriter";
import { planPromptCacheKeyInjection, responsesPromptCacheKeyRewriter } from "../../../src/plugin/responsesPromptCacheKeyRewriter";
import { applyBodyPatch } from "../../../src/plugin/patch/applyPatch";
import type { PluginContext, PluginHookHandler, RequestPlugin } from "../../../src/plugin/types";

/**
 * 内置插件改造后的契约（T2）：注册形状、`validateConfig` 参数校验、钩子产出的补丁。
 *
 * 这里测的是"新接口"这一侧；老纯函数的行为等价由原有三个 *.test.ts 守住（它们一行没改）。
 */

function context(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        hook: "before_conversion",
        clientModel: "claude-sonnet-4-5",
        clientFormat: ApiFormat.ANTHROPIC,
        upstreamFormat: ApiFormat.ANTHROPIC,
        currentFormat: ApiFormat.ANTHROPIC,
        hostKey: "host-key-1",
        clientName: "claude-code",
        ...overrides,
    };
}

function runHook(handler: PluginHookHandler | undefined, body: Record<string, unknown>, ctx: PluginContext, pluginConfig: Record<string, unknown> = {}) {
    expect(handler).toBeTypeOf("function");
    return handler!({ body, headers: new Headers() }, ctx, pluginConfig);
}

function applyHookResult(body: Record<string, unknown>, result: ReturnType<PluginHookHandler>) {
    if (!result || !result.bodyPatch) {
        return body;
    }
    return applyBodyPatch(body, result.bodyPatch).value;
}

describe("内置插件注册", () => {
    it("三个内置插件都注册在 registry 里，且都声明了转换前后两个钩子", async () => {
        // worker 门里所有测试文件共用同一份注册表，别的文件可能已经把它清空了。
        // 重建模块图后重新导入：新注册表应当是空的，导入 builtinPlugins 时由副作用填满。
        vi.resetModules();
        const freshRegistry = (await import("../../../src/plugin/pluginRegistry")).default;
        expect(freshRegistry.names()).toEqual([]);
        const freshBuiltins = await import("../../../src/plugin/builtinPlugins");

        expect(freshBuiltins.BUILTIN_PLUGINS.map((plugin) => plugin.name).sort())
            .toEqual(["cchRewriter", "claudeCodeTrackingRewriter", "responsesPromptCacheKeyRewriter"]);
        for (const plugin of freshBuiltins.BUILTIN_PLUGINS) {
            expect(freshRegistry.has(plugin.name)).toBe(true);
        }
        const described = freshRegistry.describe();
        for (const name of ["cchRewriter", "claudeCodeTrackingRewriter", "responsesPromptCacheKeyRewriter"]) {
            const entry = described.find((item) => item.name === name);
            expect(entry, `${name} 应出现在插件列表`).toBeTruthy();
            expect(entry!.hooks).toEqual(["before_conversion", "after_conversion"]);
        }
    });
});

describe("cchRewriter 参数校验", () => {
    const validate = (pluginConfig: Record<string, unknown>) => () => cchRewriter.validateConfig!(pluginConfig);

    it("空参数 / 合法 cchValue 通过", () => {
        expect(validate({})).not.toThrow();
        expect(validate({ cchValue: "A1234" })).not.toThrow();
        expect(validate({ cchValue: "A_1-b" })).not.toThrow();
        expect(validate({ cchValue: "x".repeat(32) })).not.toThrow();
    });

    it("超长、非法字符、非字符串一律拒绝", () => {
        expect(validate({ cchValue: "x".repeat(33) })).toThrow(/1~32 characters/);
        expect(validate({ cchValue: "has space" })).toThrow(/1~32 characters/);
        expect(validate({ cchValue: "a$b" })).toThrow(/1~32 characters/);
        expect(validate({ cchValue: "" })).toThrow(/1~32 characters/);
        expect(validate({ cchValue: 123 })).toThrow(/1~32 characters/);
    });

    it("只允许 cchValue 一个字段", () => {
        expect(validate({ cchValue: "A1234", extra: 1 })).toThrow(/Unknown cchRewriter config field/);
    });
});

describe("无参数插件的参数校验", () => {
    const noArgPlugins: RequestPlugin[] = [claudeCodeTrackingRewriter, responsesPromptCacheKeyRewriter];

    it.each(noArgPlugins)("$name 只接受空参数", (plugin) => {
        expect(() => plugin.validateConfig!({})).not.toThrow();
        expect(() => plugin.validateConfig!({ anything: 1 })).toThrow(/takes no config/);
    });
});

describe("cchRewriter 钩子", () => {
    const billingBody = {
        model: "claude-sonnet-4-5",
        system: "x-anthropic-billing-header: cc_version=2.1.153.9bb; cch=5a235;\nInstructions",
    };

    it("anthropic 阶段按规则参数改写（默认 A1234 / 自定义 B5678）", () => {
        const byDefault = applyHookResult(billingBody, runHook(cchRewriter.beforeConversion, billingBody, context()));
        expect(byDefault.system).toContain("cch=A1234;");

        const custom = applyHookResult(
            billingBody,
            runHook(cchRewriter.beforeConversion, billingBody, context(), { cchValue: "B5678" }),
        );
        expect(custom.system).toContain("cch=B5678;");
        expect(custom.system).not.toContain("5a235");
    });

    it("非 anthropic 阶段直接返回 undefined（本插件不处理该协议）", () => {
        expect(runHook(cchRewriter.afterConversion, billingBody, context({ currentFormat: ApiFormat.OPENAI }))).toBeUndefined();
    });

    it("没有 billing header 时不产生补丁（未改写不留痕）", () => {
        const body = { system: "just a normal system prompt" };
        expect(runHook(cchRewriter.beforeConversion, body, context())).toBeUndefined();
        expect(planCchRewrite(body, "A1234")).toEqual([]);
    });

    it("字符串接口与钩子产出同一结果（老入口没被改坏）", () => {
        const viaString = JSON.parse(rewriteCchInSystemPrompt(JSON.stringify(billingBody), "B5678"));
        const viaHook = applyHookResult(billingBody, runHook(cchRewriter.beforeConversion, billingBody, context(), { cchValue: "B5678" }));
        expect(viaHook).toEqual(viaString);
    });
});

describe("claudeCodeTrackingRewriter 钩子", () => {
    it("system 数组时只改命中的那段，路径精确到下标", () => {
        const body = {
            system: [
                { type: "text", text: "Instruction 1" },
                { type: "text", text: "# currentDate\nToday\u2019s date is 2026/06/30.\n" },
            ],
        };
        const patch = planTrackingMarkerRemoval(body);
        expect(patch).toEqual([
            { op: "replace", path: "/system/1/text", value: "# currentDate\nToday's date is 2026-06-30.\n" },
        ]);
        const applied = applyHookResult(body, runHook(claudeCodeTrackingRewriter.beforeConversion, body, context()));
        expect((applied.system as any)[1].text).toContain("2026-06-30");
        // 未命中的那段一个字节都没动
        expect((applied.system as any)[0].text).toBe("Instruction 1");
    });

    it("非 anthropic 阶段不处理", () => {
        const body = { system: "# currentDate\nToday's date is 2026/06/30.\n" };
        expect(runHook(claudeCodeTrackingRewriter.afterConversion, body, context({ currentFormat: ApiFormat.RESPONSES })))
            .toBeUndefined();
    });
});

describe("responsesPromptCacheKeyRewriter 钩子", () => {
    const responsesContext = context({
        clientFormat: ApiFormat.RESPONSES,
        upstreamFormat: ApiFormat.RESPONSES,
        currentFormat: ApiFormat.RESPONSES,
        clientName: "codex",
    });

    it("缺失时注入 ${hostKey}:${clientName}，已有值时不覆盖", () => {
        const body = { input: "hello" };
        const patch = planPromptCacheKeyInjection(body, "host-key-1", "codex");
        expect(patch).toEqual([{ op: "add", path: "/prompt_cache_key", value: "host-key-1:codex" }]);

        const applied = applyHookResult(body, runHook(responsesPromptCacheKeyRewriter.beforeConversion, body, responsesContext));
        expect(applied.prompt_cache_key).toBe("host-key-1:codex");

        const withKey = { input: "hello", prompt_cache_key: "client-key" };
        expect(runHook(responsesPromptCacheKeyRewriter.beforeConversion, withKey, responsesContext)).toBeUndefined();
        expect(planPromptCacheKeyInjection(withKey, "host-key-1", "codex")).toEqual([]);
    });

    it("非 responses 阶段不处理", () => {
        const body = { input: "hello" };
        expect(runHook(responsesPromptCacheKeyRewriter.beforeConversion, body, context())).toBeUndefined();
    });
});
