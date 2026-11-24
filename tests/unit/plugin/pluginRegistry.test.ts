import { beforeEach, describe, expect, it } from "vitest";
import pluginRegistry from "../../../src/plugin/pluginRegistry";
import type { RequestPlugin } from "../../../src/plugin/types";

function makePlugin(name: string, overrides: Partial<RequestPlugin> = {}): RequestPlugin {
    return {
        name,
        beforeConversion: () => undefined,
        ...overrides,
    };
}

describe("pluginRegistry", () => {
    // worker 门里所有测试文件共用同一份注册表，所以"空注册表"这个前提必须自己建立
    beforeEach(() => {
        pluginRegistry.resetForTest();
    });

    it("注册后可按名取回，has / names 同步", () => {
        const plugin = makePlugin("demoPlugin");
        pluginRegistry.register(plugin);

        expect(pluginRegistry.get("demoPlugin")).toBe(plugin);
        expect(pluginRegistry.has("demoPlugin")).toBe(true);
        expect(pluginRegistry.names()).toEqual(["demoPlugin"]);
    });

    it("未注册的名字返回 null（不抛错，由调用方决定如何处理）", () => {
        expect(pluginRegistry.get("missing")).toBeNull();
        expect(pluginRegistry.has("missing")).toBe(false);
    });

    it("重复注册同名插件直接抛错，不静默覆盖前一份", () => {
        pluginRegistry.register(makePlugin("dupPlugin"));
        expect(() => pluginRegistry.register(makePlugin("dupPlugin"))).toThrow(/already registered/);
        expect(pluginRegistry.get("dupPlugin")?.beforeConversion).toBeTypeOf("function");
    });

    it("非法插件名拒绝注册（必须字母开头、字母数字下划线）", () => {
        expect(() => pluginRegistry.register(makePlugin("1bad"))).toThrow(/Invalid request plugin name/);
        expect(() => pluginRegistry.register(makePlugin("bad-name"))).toThrow(/Invalid request plugin name/);
        expect(() => pluginRegistry.register(makePlugin(""))).toThrow(/Invalid request plugin name/);
    });

    it("一个钩子都没实现的插件拒绝注册（注册了也永远不执行，属于配置错误）", () => {
        expect(() => pluginRegistry.register({ name: "noHook" })).toThrow(/implements no hook/);
    });

    it("describe 按名称升序，hooks 只列已实现的钩子", () => {
        pluginRegistry.registerAll([
            makePlugin("zzzPlugin", { beforeConversion: undefined, afterConversion: () => undefined, description: "after only" }),
            makePlugin("aaaPlugin", { beforeConversion: () => undefined, configExample: { cchValue: "A1234" } }),
        ]);

        const described = pluginRegistry.describe();
        expect(described.map((item) => item.name)).toEqual(["aaaPlugin", "zzzPlugin"]);
        expect(described[0].hooks).toEqual(["before_conversion"]);
        expect(described[0].configExample).toEqual({ cchValue: "A1234" });
        expect(described[1].hooks).toEqual(["after_conversion"]);
        expect(described[1].description).toBe("after only");
        // 两个钩子都实现时按固定顺序输出
        pluginRegistry.register(makePlugin("bothPlugin", { afterConversion: () => undefined }));
        expect(pluginRegistry.describe().find((item) => item.name === "bothPlugin")?.hooks)
            .toEqual(["before_conversion", "after_conversion"]);
    });

    it("registerAll 是原子的：任一插件非法则一个都不注册", () => {
        pluginRegistry.register(makePlugin("existingPlugin"));
        expect(() => pluginRegistry.registerAll([
            makePlugin("freshPlugin"),
            makePlugin("existingPlugin"), // 与已注册的重名
        ])).toThrow(/already registered/);

        expect(pluginRegistry.has("freshPlugin")).toBe(false);
        expect(pluginRegistry.names()).toEqual(["existingPlugin"]);
    });
});
