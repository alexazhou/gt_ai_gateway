import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ruleManager from "../../../src/manager/ruleManager";
import ruleService from "../../../src/service/ruleService";
import tenantService from "../../../src/service/tenantService";
import { RuleType, UserType } from "../../../src/constants";
import { SgUser } from "../../../src/model/sgUser";
import { SgModel } from "../../../src/model/sgModel";
import { SgVendor } from "../../../src/model/sgVendor";
import customError from "../../../src/customError";
import pluginRegistry from "../../../src/plugin/pluginRegistry";
import type { RequestPlugin } from "../../../src/plugin/types";
import dbHelper from "../../helpers/dbHelper";
import ormTestHelper from "../../helpers/ormTestHelper";
import stateStoreService from "../../../src/service/stateStoreService";
import type { TenantScope } from "../../../src/service/tenantService";

/**
 * 插件规则（type = plugin）在规则层的语义（T3）：
 *
 * - 校验：`config = { plugin, pluginConfig }`，插件必须已注册，参数交给插件 `validateConfig`；
 * - 匹配：只在选定上游后匹配（vendor_id 可用），按 `(priority, id)` 返回执行顺序；
 * - 隔离：插件规则**不参与**路由前/路由后的准入检查（否则一条写错 config 的插件规则会把请求拒掉）。
 */
describe("ruleService 插件规则 (node, real db)", () => {
    let tenantId = 1;
    let mainTenantId = 1;

    /** validateConfig 收到的参数，供断言"校验真的被执行了" */
    const validatedConfigs: Record<string, unknown>[] = [];

    const fakePlugin: RequestPlugin = {
        name: "testPlugin",
        description: "测试插件",
        beforeConversion: () => undefined,
        validateConfig(params) {
            validatedConfigs.push(params);
            const mode = params.mode;
            if (mode !== undefined && mode !== "a" && mode !== "b") {
                throw new customError.AppError("config.pluginConfig.mode must be \"a\" or \"b\"");
            }
        },
    };

    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
        pluginRegistry.register(fakePlugin);
    });

    afterAll(() => {
        pluginRegistry.resetForTest();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
        tenantId = await tenantService.getMainTenantId();
        mainTenantId = tenantId;
        stateStoreService.reset();
        ruleService.invalidateCache();
        validatedConfigs.length = 0;
    });

    function tenantScope(): TenantScope {
        return { tenantId, mainTenantId, isSystemAdmin: false, multiTenantEnabled: true };
    }

    function user(id: number, type: UserType = UserType.NORMAL): SgUser {
        return { id, type } as unknown as SgUser;
    }

    function model(id: number): SgModel {
        return { id } as unknown as SgModel;
    }

    function vendor(id: number): SgVendor {
        return { id } as unknown as SgVendor;
    }

    const constTrue = { type: "const", values: [true] };

    async function createPluginRule(overrides: Record<string, any> = {}) {
        return ruleManager.create({
            type: RuleType.PLUGIN,
            name: overrides.name ?? "plugin-rule",
            scope: overrides.scope ?? constTrue,
            config: overrides.config ?? { plugin: "testPlugin", pluginConfig: {} },
            enabled: overrides.enabled ?? true,
            priority: overrides.priority,
            tenant_id: tenantId,
        }, tenantId);
    }

    describe("validateRule: priority 与 pluginConfig", () => {
        it("priority 必须是 0~10000 的整数；未提供则跳过（局部更新/默认 100）", () => {
            const base = { type: RuleType.RATE_LIMIT, scope: constTrue, config: { rpm: 10 } };
            expect(() => ruleService.validateRule({ ...base, priority: 0 })).not.toThrow();
            expect(() => ruleService.validateRule({ ...base, priority: 10000 })).not.toThrow();
            expect(() => ruleService.validateRule({ ...base, priority: undefined })).not.toThrow();

            for (const priority of [-1, 10001, 1.5, "50", null, true, Number.NaN]) {
                expect(() => ruleService.validateRule({ ...base, priority }))
                    .toThrow(/priority must be an integer/);
            }
        });

        it("插件规则校验 config 结构：必须 { plugin, pluginConfig }，未知字段拒绝", () => {
            const scope = constTrue;
            // 缺 plugin
            expect(() => ruleService.validateRule({ type: RuleType.PLUGIN, scope, config: {} }))
                .toThrow(/config\.plugin is required/);
            // plugin 不是字符串
            expect(() => ruleService.validateRule({ type: RuleType.PLUGIN, scope, config: { plugin: 42 } }))
                .toThrow(/config\.plugin is required/);
            // 未注册的插件
            expect(() => ruleService.validateRule({ type: RuleType.PLUGIN, scope, config: { plugin: "nope" } }))
                .toThrow(/Unknown request plugin/);
            // 多余字段
            expect(() => ruleService.validateRule({
                type: RuleType.PLUGIN,
                scope,
                config: { plugin: "testPlugin", pluginConfig: {}, extra: 1 },
            })).toThrow(/Unknown plugin rule config field/);
            // pluginConfig 不是对象
            expect(() => ruleService.validateRule({
                type: RuleType.PLUGIN,
                scope,
                config: { plugin: "testPlugin", pluginConfig: [1] },
            })).toThrow(/pluginConfig must be an object/);
            // config 整体不是对象
            expect(() => ruleService.validateRule({ type: RuleType.PLUGIN, scope, config: "x" }))
                .toThrow(/requires a config object/);
        });

        it("插件自身的 validateConfig 被调用，且不合法参数会 400（抛 AppError）", () => {
            const scope = constTrue;
            expect(() => ruleService.validateRule({
                type: RuleType.PLUGIN,
                scope,
                config: { plugin: "testPlugin", pluginConfig: { mode: "b" } },
            })).not.toThrow();
            expect(validatedConfigs).toEqual([{ mode: "b" }]);

            expect(() => ruleService.validateRule({
                type: RuleType.PLUGIN,
                scope,
                config: { plugin: "testPlugin", pluginConfig: { mode: "z" } },
            })).toThrow(/must be "a" or "b"/);

            // 未提供 pluginConfig → 视为 {} 并交给插件校验
            expect(() => ruleService.validateRule({
                type: RuleType.PLUGIN,
                scope,
                config: { plugin: "testPlugin" },
            })).not.toThrow();
            expect(validatedConfigs.at(-1)).toEqual({});
        });
    });

    describe("matchPluginRules", () => {
        it("按 (priority ASC, id ASC) 返回执行顺序，同优先级按 id 升序", async () => {
            const p30 = await createPluginRule({ name: "p30", priority: 30 });
            const p10 = await createPluginRule({ name: "p10", priority: 10 });
            const p20 = await createPluginRule({ name: "p20", priority: 20 });
            const p20b = await createPluginRule({ name: "p20b", priority: 20 });
            ruleService.invalidateCache();

            // 清表后 dbHelper 会重建三条系统插件规则（priority 10/20/30），它们也会命中 const true
            const matched = await ruleService.matchPluginRules(user(1), model(5), vendor(9), tenantScope());
            // 全量不变式：priority 单调不减（同优先级谁在前由 id 决定，而 sqlite AUTOINCREMENT
            // 跨用例不重置，系统规则与新建规则的 id 大小关系不固定，所以只断言优先级单调）
            const priorities = matched.map((item) => item.rule.priority);
            expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
            expect(matched.filter((item) => item.rule.source === "system")).toHaveLength(3);

            const userMatched = matched.filter((item) => item.rule.source === "user");
            expect(userMatched.map((item) => item.rule.name)).toEqual(["p10", "p20", "p20b", "p30"]);
            expect(userMatched.map((item) => item.rule.id)).toEqual([p10.id, p20.id, p20b.id, p30.id]);
            // 插件名与参数一并解析出来，管线层不用再拆 config
            expect(userMatched[0].pluginName).toBe("testPlugin");
            expect(userMatched[0].pluginConfig).toEqual({});
        });

        it("按 scope 匹配（user_id / model_id / vendor_id），不命中不返回", async () => {
            await createPluginRule({
                name: "only-vendor-9",
                scope: { type: "vendor_id", oper: "=", values: [9] },
            });
            await createPluginRule({
                name: "only-user-2",
                scope: { type: "user_id", oper: "=", values: [2] },
            });
            ruleService.invalidateCache();

            // 系统规则（const true）恒命中，按来源切出用户规则来断言 scope 语义
            const userOnly = (matched: Awaited<ReturnType<typeof ruleService.matchPluginRules>>) =>
                matched.filter((item) => item.rule.source === "user").map((item) => item.rule.name);

            const hit9 = await ruleService.matchPluginRules(user(1), model(5), vendor(9), tenantScope());
            expect(userOnly(hit9)).toEqual(["only-vendor-9"]);

            const hit2 = await ruleService.matchPluginRules(user(2), model(5), vendor(7), tenantScope());
            expect(userOnly(hit2)).toEqual(["only-user-2"]);

            const none = await ruleService.matchPluginRules(user(3), model(5), vendor(7), tenantScope());
            expect(userOnly(none)).toEqual([]);
        });

        it("停用规则、非插件规则都不参与插件管道", async () => {
            await createPluginRule({ name: "enabled-one" });
            await createPluginRule({ name: "disabled-one", enabled: false });
            await ruleManager.create({
                type: RuleType.RATE_LIMIT,
                name: "rpm-rule",
                scope: constTrue,
                config: { rpm: 1 },
                enabled: true,
            }, tenantId);
            ruleService.invalidateCache();

            const matched = await ruleService.matchPluginRules(user(1), model(5), vendor(9), tenantScope());
            const userNames = matched
                .filter((item) => item.rule.source === "user")
                .map((item) => item.rule.name);
            expect(userNames).toEqual(["enabled-one"]);
        });

        it("插件规则不进准入检查：写错 config 的插件规则不该把请求拒掉", async () => {
            // 故意造一条 config 里没有 plugin 的坏规则（迁移/手工改库才可能出现的形态）
            await ruleManager.create({
                type: RuleType.PLUGIN,
                name: "broken-plugin-rule",
                scope: constTrue,
                config: {},
                enabled: true,
            }, tenantId);
            ruleService.invalidateCache();

            // 准入两阶段都不应因它抛错（plugin 类型被过滤到 pluginRules 桶里）
            await expect(ruleService.matchAndCheck(user(1), model(5), tenantScope())).resolves.toBeUndefined();
            await expect(ruleService.matchAndCheckVendor(user(1), model(5), vendor(9), tenantScope())).resolves.toBeUndefined();
        });
    });
});
