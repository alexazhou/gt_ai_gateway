import { RULE_NOTE_MAX_LENGTH, RULE_PRIORITY_MAX, RULE_PRIORITY_MIN, RuleType } from "../constants";
import { SgUser } from "../model/sgUser";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";
import SgRule from "../model/sgRule";
import ruleManager from "../manager/ruleManager";
import rateLimitService from "./rateLimitService";
import customError from "../customError";
import scopeExpr from "../util/rule/scopeExpr";
import pluginRegistry from "../plugin/pluginRegistry";
// 内置插件注册（模块副作用）：保存规则时要按名校验 config.plugin 是否存在
import "../plugin/builtinPlugins";
import type { RequestContext } from "../util/rule/types";
import type { TenantScope } from "../service/tenantService";

// 规则缓存 TTL：兜底 worker 多 isolate 的跨实例缓存过期（CRUD 只失效本地 isolate 缓存，
// 其他 isolate 需等 TTL 过期才能感知变更，60s 内全局生效）
const RULE_CACHE_TTL_MS = 60_000;

interface RuleCache {
    // 不含 vendor_id 的启用规则：阶段一（路由前）检查
    nonVendorRules: SgRule[];
    // 含 vendor_id 的启用规则：阶段二（路由后）检查
    vendorRules: SgRule[];
    // 插件规则：选定上游后按 (priority, id) 顺序执行，不参与上面两个准入阶段
    pluginRules: SgRule[];
    loadedAt: number;
}

// 规则缓存按租户区分（key = tenantId:mainTenantId），避免跨租户串计数
const ruleCacheMap = new Map<string, RuleCache>();

function cacheKey(tenantId: number, mainTenantId: number): string {
    return `${tenantId}:${mainTenantId}`;
}

// 规则 CRUD 后即时失效本地缓存（ruleManager 在写入后触发监听器）
ruleManager.onInvalidate(() => {
    ruleCacheMap.clear();
});

async function getEnabledRules(tenantId: number, mainTenantId: number): Promise<RuleCache> {
    const now = Date.now();
    const key = cacheKey(tenantId, mainTenantId);
    const cached = ruleCacheMap.get(key);
    if (cached && now - cached.loadedAt < RULE_CACHE_TTL_MS) {
        return cached;
    }

    const rules = await ruleManager.listEnabled(tenantId, mainTenantId);
    // 插件规则单独成列：它们不在「路由前 / 路由后」两个准入阶段里跑，而是选定上游后按序执行；
    // 准入规则保持原有分流语义（含 PLUGIN 的规则不参与准入检查）
    const accessRules = rules.filter((rule) => rule.type !== RuleType.PLUGIN);
    const cache: RuleCache = {
        nonVendorRules: accessRules.filter(rule => !scopeExpr.exprReferencesVendor(rule.scope)),
        vendorRules: accessRules.filter(rule => scopeExpr.exprReferencesVendor(rule.scope)),
        pluginRules: rules.filter((rule) => rule.type === RuleType.PLUGIN),
        loadedAt: now,
    };
    ruleCacheMap.set(key, cache);
    return cache;
}

function invalidateCache(): void {
    ruleCacheMap.clear();
}


/**
 * 校验规则载荷（create / update 共用）：type 已注册、scope 为合法表达式树、config 按 type 校验。
 *
 * 更新是「局部字段」语义：请求体没带 `priority` 就不校验也不覆盖（库中原值保留）；
 * 带了就必须是 0~10000 的整数（`null` 也算提供了非法值，不做"清空回默认"的隐式解释）。
 */
function validateRule(data: Record<string, any>): void {
    const ruleType = data.type;
    if (
        ruleType !== RuleType.RATE_LIMIT
        && ruleType !== RuleType.ACCESS_CONTROL
        && ruleType !== RuleType.PLUGIN
    ) {
        throw new customError.AppError(`Unsupported rule type: ${String(ruleType)}`);
    }

    // scope：合法表达式树（含空 and/or、非法运算符、const 非 [true]、深度超限等拒绝）
    scopeExpr.validateScope(data.scope);

    validatePriority(data.priority);
    validateNote(data.note);

    if (ruleType === RuleType.RATE_LIMIT) {
        // rpm：非负整数或 null（null / 缺省 = 不限制；0 = 不可用；N > 0 = 滑动窗口上限）
        const rpm = data.config?.rpm;
        if (
            rpm !== null
            && rpm !== undefined
            && (typeof rpm !== "number" || !Number.isInteger(rpm) || rpm < 0)
        ) {
            throw new customError.AppError("config.rpm must be a non-negative integer or null");
        }
    } else if (ruleType === RuleType.ACCESS_CONTROL) {
        // forbid_access：config 必须为空 {}
        const config = data.config ?? {};
        if (typeof config !== "object" || config === null || Array.isArray(config) || Object.keys(config).length > 0) {
            throw new customError.AppError("forbid_access rule requires an empty config {}");
        }
    } else {
        validatePluginRuleConfig(data.config);
    }
}


/** 备注：可选字符串，最长 RULE_NOTE_MAX_LENGTH；null / 未提供都表示没有备注（局部更新未传则跳过） */
function validateNote(note: unknown): void {
    if (note === undefined || note === null) {
        return;
    }
    if (typeof note !== "string") {
        throw new customError.AppError("note must be a string");
    }
    if (note.length > RULE_NOTE_MAX_LENGTH) {
        throw new customError.AppError(`note must be at most ${RULE_NOTE_MAX_LENGTH} characters`);
    }
}


/** 优先级：0 ~ 10000 的整数；未提供则跳过（局部更新 / 依赖 DB 默认 100） */
function validatePriority(priority: unknown): void {
    if (priority === undefined) {
        return;
    }
    if (
        typeof priority !== "number"
        || !Number.isInteger(priority)
        || priority < RULE_PRIORITY_MIN
        || priority > RULE_PRIORITY_MAX
    ) {
        throw new customError.AppError(
            `priority must be an integer between ${RULE_PRIORITY_MIN} and ${RULE_PRIORITY_MAX}`,
        );
    }
}


/**
 * 插件规则的 config 校验：`{ plugin, pluginConfig }`，插件必须已注册，参数交给插件的 `validateConfig`。
 *
 * 这里**不**做参数的表单化渲染或默认值填充（产品边界：插件参数只提供 JSON 文本 + 后端校验）；
 * 未填 `pluginConfig` 视为 `{}`。
 */
function validatePluginRuleConfig(config: unknown): void {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
        throw new customError.AppError("plugin rule requires a config object { plugin, pluginConfig }");
    }

    const keys = Object.keys(config as Record<string, unknown>);
    const unknownKeys = keys.filter((key) => key !== "plugin" && key !== "pluginConfig");
    if (unknownKeys.length > 0) {
        throw new customError.AppError(`Unknown plugin rule config field(s): ${unknownKeys.join(", ")}`);
    }

    const { plugin: pluginName, pluginConfig } = config as { plugin?: unknown; pluginConfig?: unknown };
    if (typeof pluginName !== "string" || pluginName.trim() === "") {
        throw new customError.AppError("config.plugin is required for plugin rule");
    }

    const plugin = pluginRegistry.get(pluginName);
    if (!plugin) {
        throw new customError.AppError(`Unknown request plugin: ${pluginName}`);
    }

    const params = pluginConfig ?? {};
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new customError.AppError("config.pluginConfig must be an object");
    }
    plugin.validateConfig?.(params as Record<string, unknown>);
}


// 阶段内统一匹配逻辑：forbid_access 先于 rate_limit（无权限请求不消耗限流计数），deny-wins
async function checkMatchedRules(
    rules: SgRule[],
    ctx: RequestContext,
    failoverEligible: boolean,
): Promise<void> {
    // 先判权限：任一命中的 forbid_access 规则 → 403（不 failover，策略性拒绝与供应商无关）
    for (const rule of rules) {
        if (rule.type === RuleType.ACCESS_CONTROL && scopeExpr.evalExpr(rule.scope, ctx)) {
            throw new customError.AccessDeniedError(
                `Access denied by rule "${rule.name}"`,
                Number(rule.id),
                rule.name,
            );
        }
    }
    // 再判限流：命中的 rate_limit 规则逐个准入（任一超限即抛 429）
    for (const rule of rules) {
        if (rule.type === RuleType.RATE_LIMIT && scopeExpr.evalExpr(rule.scope, ctx)) {
            await rateLimitService.checkAndAdmit(rule, ctx, { failoverEligible });
        }
    }
}


/**
 * 阶段一：路由前准入检查（不含 vendor_id 的规则，此时尚未路由、vendor_id 未知）。
 * 对所有用户一视同仁（含 root，无旁路）。
 * 命中拒绝时抛 AccessDeniedError（403）/ RateLimitError（429）。
 */
async function matchAndCheck(user: SgUser, modelConfig: SgModel, scope: TenantScope): Promise<void> {
    const { nonVendorRules } = await getEnabledRules(scope.tenantId, scope.mainTenantId);
    if (nonVendorRules.length === 0) {
        return;
    }
    const ctx: RequestContext = {
        user_id: user.id,
        model_id: Number(modelConfig.id),
    };
    await checkMatchedRules(nonVendorRules, ctx, false);
}


/**
 * 阶段二：路由后准入检查（含 vendor_id 的规则，实际路由到的供应商已确定）。
 * 对所有用户一视同仁（含 root，无旁路）。
 * rate_limit 传 failoverEligible = true（超限视为该上游繁忙，可切换其它供应商）。
 */
async function matchAndCheckVendor(user: SgUser, modelConfig: SgModel, vendor: SgVendor, scope: TenantScope): Promise<void> {
    const { vendorRules } = await getEnabledRules(scope.tenantId, scope.mainTenantId);
    if (vendorRules.length === 0) {
        return;
    }
    const ctx: RequestContext = {
        user_id: user.id,
        model_id: Number(modelConfig.id),
        vendor_id: Number(vendor.id),
    };
    await checkMatchedRules(vendorRules, ctx, true);
}

/** 命中一条插件规则的匹配结果：规则本体 + 已解析好的插件名与参数 */
export interface MatchedPluginRule {
    rule: SgRule;
    pluginName: string;
    pluginConfig: Record<string, unknown>;
}


/**
 * 匹配本次上游的插件规则（选定供应商之后调用，因此 vendor_id 可用）。
 *
 * 返回顺序即执行顺序：`(priority ASC, id ASC)` —— 排序来自 `ruleManager.listEnabled` 的 SQL，
 * 这里**不再排一次**（重复排序只会掩盖上游漏排）。不去重：一条规则命中一次就执行一次，
 * 后执行的规则在前序结果上继续改写。
 */
async function matchPluginRules(
    user: SgUser,
    modelConfig: SgModel,
    vendor: SgVendor,
    scope: TenantScope,
): Promise<MatchedPluginRule[]> {
    const { pluginRules } = await getEnabledRules(scope.tenantId, scope.mainTenantId);
    if (pluginRules.length === 0) {
        return [];
    }
    const ctx: RequestContext = {
        user_id: user.id,
        model_id: Number(modelConfig.id),
        vendor_id: Number(vendor.id),
    };
    const matched: MatchedPluginRule[] = [];
    for (const rule of pluginRules) {
        if (!scopeExpr.evalExpr(rule.scope, ctx)) {
            continue;
        }
        const config = (rule.config ?? {}) as { plugin?: unknown; pluginConfig?: unknown };
        matched.push({
            rule,
            pluginName: String(config.plugin ?? ""),
            pluginConfig: (config.pluginConfig as Record<string, unknown>) ?? {},
        });
    }
    return matched;
}


export default {
    matchAndCheck,
    matchAndCheckVendor,
    matchPluginRules,
    validateRule,
    invalidateCache,
};
