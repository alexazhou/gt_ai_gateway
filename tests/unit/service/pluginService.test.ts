import { afterAll, describe, expect, it } from "vitest";
import pluginService, { type ApplyPluginsOptions } from "../../../src/service/pluginService";
import type { MatchedPluginRule } from "../../../src/service/ruleService";
import pluginRegistry from "../../../src/plugin/pluginRegistry";
import { BUILTIN_PLUGINS } from "../../../src/plugin/builtinPlugins";
import type { RequestPlugin } from "../../../src/plugin/types";
import type SgRule from "../../../src/model/sgRule";
import { ApiFormat } from "../../../src/constants";

/**
 * 插件管线（T5）：规则已经由 ruleService 匹配好，本层只负责"按顺序执行 + 落地补丁 + 容错"。
 *
 * 与改造前的老测试（`configService` 开关驱动）的区别：**是否生效不再由配置决定，而是由命中规则决定**。
 * 所以原来那两条"enabled=false ⇒ 不生效"的用例，现在对应"没有命中规则 ⇒ 原样返回"。
 */

function matchedRule(
    id: number,
    name: string,
    priority: number,
    pluginName: string,
    pluginConfig: Record<string, unknown> = {},
): MatchedPluginRule {
    return {
        rule: { id, name, priority } as unknown as SgRule,
        pluginName,
        pluginConfig,
    };
}

function options(overrides: Partial<ApplyPluginsOptions> = {}): ApplyPluginsOptions {
    return {
        hook: "before_conversion",
        body: JSON.stringify({ model: "m" }),
        headers: new Headers({ "x-client-trace": "abc" }),
        matchedRules: [],
        context: {
            clientModel: "claude-sonnet-4-5",
            clientFormat: ApiFormat.ANTHROPIC,
            upstreamFormat: ApiFormat.ANTHROPIC,
            currentFormat: ApiFormat.ANTHROPIC,
            hostKey: "host-key-1",
            clientName: "claude-code",
        },
        ...overrides,
    };
}

const billingBody = JSON.stringify({
    model: "vendor-model",
    system: "x-anthropic-billing-header: cc_version=2; cch=old;\n# currentDate\nToday's date is 2026/06/30.\n",
});

/** 测试专用插件：只用于验证 headerPatch 与"插件抛错"这两条路径 */
const headerPlugin: RequestPlugin = {
    name: "t5HeaderPlugin",
    beforeConversion: () => ({ headerPatch: { set: { "x-request-source": "gateway" }, remove: ["x-client-trace"] } }),
};

const throwingPlugin: RequestPlugin = {
    name: "t5ThrowingPlugin",
    beforeConversion: () => {
        throw new Error("boom");
    },
};

const forbiddenPatchPlugin: RequestPlugin = {
    name: "t5ForbiddenPatchPlugin",
    beforeConversion: () => ({ bodyPatch: [{ op: "replace", path: "/model", value: "hijacked" }] }),
};

const protectedHeaderPlugin: RequestPlugin = {
    name: "t5ProtectedHeaderPlugin",
    beforeConversion: () => ({ headerPatch: { set: { authorization: "Bearer evil" } } }),
};

pluginRegistry.registerAll([headerPlugin, throwingPlugin, forbiddenPatchPlugin, protectedHeaderPlugin]);

afterAll(() => {
    pluginRegistry.resetForTest();
    // worker 门是 `isolate: false`：同一进程里所有测试文件共享这一份插件注册表。
    // 只 reset 不还原，排在本文件后面的用例（如 pluginContracts 的「内置插件已注册」）
    // 就会看到一个空注册表——本文件注册的是自己的假插件，收尾必须把内置插件放回去。
    pluginRegistry.registerAll(BUILTIN_PLUGINS);
});

describe("pluginService 管线", () => {
    it("没有命中规则时原样返回（连字符串都不重新序列化）", async () => {
        const body = `{"model":"m",  "spaced":  true}`;
        const result = await pluginService.applyRequestPlugins(options({ body }));

        expect(result.body).toBe(body);
        expect(result.executed).toEqual([]);
        expect(result.issues).toEqual([]);
    });

    it("多条规则按入参顺序执行，后一条在前一条结果上继续改（tracking 10 → CCH 20）", async () => {
        const result = await pluginService.applyRequestPlugins(options({
            body: billingBody,
            matchedRules: [
                matchedRule(1, "屏蔽追踪标记", 10, "claudeCodeTrackingRewriter"),
                matchedRule(2, "强制改写 CCH", 20, "cchRewriter", { cchValue: "B5678" }),
            ],
        }));

        const parsed = JSON.parse(result.body);
        // 两条都生效：日期被规范化 + cch 被改成规则参数
        expect(parsed.system).toContain("2026-06-30");
        expect(parsed.system).toContain("cch=B5678;");

        expect(result.executed).toHaveLength(2);
        expect(result.executed.map((item) => item.plugin)).toEqual(["claudeCodeTrackingRewriter", "cchRewriter"]);
        expect(result.executed.map((item) => item.priority)).toEqual([10, 20]);
        expect(result.executed[0].rule).toEqual({ id: 1, name: "屏蔽追踪标记" });
        expect(result.executed[0].paths).toEqual(["/system"]);
        expect(result.executed[1].paths).toEqual(["/system"]);
        expect(result.issues).toEqual([]);
    });

    it("同一请求体被两条规则连续改写时，前一条的结果是后一条的输入", async () => {
        // 第一条把 cch 改成 A1111，第二条再改成 B2222 —— 最终必须是 B2222（顺序真的在叠加）
        const result = await pluginService.applyRequestPlugins(options({
            body: billingBody,
            matchedRules: [
                matchedRule(1, "first", 10, "cchRewriter", { cchValue: "A1111" }),
                matchedRule(2, "second", 20, "cchRewriter", { cchValue: "B2222" }),
            ],
        }));

        const parsed = JSON.parse(result.body);
        expect(parsed.system).toContain("cch=B2222;");
        expect(parsed.system).not.toContain("A1111");
        expect(result.executed).toHaveLength(2);
    });

    it("插件抛错 / 未注册 / 补丁违规都只记 issue，不影响后续规则与请求体", async () => {
        const result = await pluginService.applyRequestPlugins(options({
            body: billingBody,
            matchedRules: [
                matchedRule(1, "抛错", 10, "t5ThrowingPlugin"),
                matchedRule(2, "未注册", 20, "noSuchPlugin"),
                matchedRule(3, "改受保护字段", 30, "t5ForbiddenPatchPlugin"),
                matchedRule(4, "正常插件", 40, "cchRewriter", { cchValue: "C3333" }),
            ],
        }));

        expect(result.issues.map((issue) => issue.reason.split(/[:@]/)[0].trim())).toEqual([
            "boom",
            "plugin is not registered",
            "protected_field",
        ]);
        // 后面那条合法规则照常生效：一条坏规则不该连坐
        expect(JSON.parse(result.body).system).toContain("cch=C3333;");
        expect(result.executed.map((item) => item.plugin)).toEqual(["cchRewriter"]);
    });

    it("headerPatch 落地到返回的 Headers 上，路径记为 header:<名>", async () => {
        const result = await pluginService.applyRequestPlugins(options({
            matchedRules: [matchedRule(1, "加个来源头", 10, "t5HeaderPlugin")],
        }));

        expect(result.headers.get("x-request-source")).toBe("gateway");
        expect(result.headers.has("x-client-trace")).toBe(false);
        expect(result.executed[0].paths).toEqual(["header:x-request-source", "header:x-client-trace"]);
        expect(result.headers.get("authorization")).toBeNull();
    });

    it("插件改鉴权头被补丁层拒绝（受保护头），记 issue 且头不变", async () => {
        const result = await pluginService.applyRequestPlugins(options({
            matchedRules: [matchedRule(1, "改鉴权头", 10, "t5ProtectedHeaderPlugin")],
        }));

        expect(result.issues[0].reason).toMatch(/^protected_header/);
        expect(result.headers.get("authorization")).toBeNull();
        expect(result.executed).toEqual([]);
    });

    it("本阶段未实现钩子的插件静默跳过（不算问题）", async () => {
        const result = await pluginService.applyRequestPlugins(options({
            hook: "after_conversion",
            body: billingBody,
            matchedRules: [matchedRule(1, "只有 before", 10, "t5HeaderPlugin2")],
        }));
        // 未注册名字 → 是 issue；这里用一个"只实现 before"的插件验证钩子缺席的情况
        expect(result.issues.length).toBeLessThanOrEqual(1);

        pluginRegistry.register({
            name: "t5BeforeOnlyPlugin",
            beforeConversion: () => undefined,
        });
        const skipped = await pluginService.applyRequestPlugins(options({
            hook: "after_conversion",
            body: billingBody,
            matchedRules: [matchedRule(1, "只有 before", 10, "t5BeforeOnlyPlugin")],
        }));
        expect(skipped.executed).toEqual([]);
        expect(skipped.issues).toEqual([]);
    });

    it("请求体不是 JSON 对象时跳过插件、原样返回（不报错）", async () => {
        const result = await pluginService.applyRequestPlugins(options({
            body: "not-json",
            matchedRules: [matchedRule(1, "cch", 10, "cchRewriter")],
        }));
        expect(result.body).toBe("not-json");
        expect(result.executed).toEqual([]);
        expect(result.issues).toEqual([]);
    });

    it("返回的 Headers 是副本：改它不影响调用方手里那份", async () => {
        const original = new Headers({ "x-keep": "1" });
        const result = await pluginService.applyRequestPlugins(options({
            headers: original,
            matchedRules: [matchedRule(1, "加个来源头", 10, "t5HeaderPlugin")],
        }));

        expect(result.headers).not.toBe(original);
        expect(original.get("x-request-source")).toBeNull();
    });
});
