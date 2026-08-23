import { RuleType, UserType } from "../constants";
import { SgUser } from "../model/sgUser";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";
import SgRule from "../model/sgRule";
import ruleManager from "../manager/ruleManager";
import rateLimitService from "./rateLimitService";
import customError from "../customError";
import scopeExpr from "../util/rule/scopeExpr";
import type { RequestContext } from "../util/rule/types";

// 规则缓存 TTL：兜底 worker 多 isolate 的跨实例缓存过期（CRUD 只失效本地 isolate 缓存，
// 其他 isolate 需等 TTL 过期才能感知变更，60s 内全局生效）
const RULE_CACHE_TTL_MS = 60_000;

interface RuleCache {
    // 不含 vendor_id 的启用规则：阶段一（路由前）检查
    nonVendorRules: SgRule[];
    // 含 vendor_id 的启用规则：阶段二（路由后）检查
    vendorRules: SgRule[];
    loadedAt: number;
}

let ruleCache: RuleCache | null = null;

// 规则 CRUD 后即时失效本地缓存（ruleManager 在写入后触发监听器）
ruleManager.onInvalidate(() => {
    ruleCache = null;
});

async function getEnabledRules(): Promise<RuleCache> {
    const now = Date.now();
    if (ruleCache && now - ruleCache.loadedAt < RULE_CACHE_TTL_MS) {
        return ruleCache;
    }

    const rules = await ruleManager.listEnabled();
    const cache: RuleCache = {
        nonVendorRules: rules.filter(rule => !scopeExpr.exprReferencesVendor(rule.scope)),
        vendorRules: rules.filter(rule => scopeExpr.exprReferencesVendor(rule.scope)),
        loadedAt: now,
    };
    ruleCache = cache;
    return cache;
}

function invalidateCache(): void {
    ruleCache = null;
}


/** 校验规则载荷（create / update 共用）：type 已注册、scope 为合法表达式树、config 按 type 校验 */
function validateRule(data: Record<string, any>): void {
    const ruleType = data.type;
    if (ruleType !== RuleType.RATE_LIMIT && ruleType !== RuleType.ACCESS_CONTROL) {
        throw new customError.AppError(`Unsupported rule type: ${String(ruleType)}`);
    }

    // scope：合法表达式树（含空 and/or、非法运算符、const 非 [true]、深度超限等拒绝）
    scopeExpr.validateScope(data.scope);

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
    } else {
        // access_control：config 必须为空 {}
        const config = data.config ?? {};
        if (typeof config !== "object" || config === null || Array.isArray(config) || Object.keys(config).length > 0) {
            throw new customError.AppError("access_control rule requires an empty config {}");
        }
    }
}


// 阶段内统一匹配逻辑：access_control 先于 rate_limit（无权限请求不消耗限流计数），deny-wins
async function checkMatchedRules(
    rules: SgRule[],
    ctx: RequestContext,
    failoverEligible: boolean,
): Promise<void> {
    // 先判权限：任一命中的 access_control 规则 → 403（不 failover，策略性拒绝与供应商无关）
    for (const rule of rules) {
        if (rule.type === RuleType.ACCESS_CONTROL && scopeExpr.evalExpr(rule.scope, ctx)) {
            throw new customError.AccessDeniedError(`Access denied by rule "${rule.name}"`);
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
 * root 用户直接旁路（不匹配、不计数）。命中拒绝时抛 AccessDeniedError（403）/ RateLimitError（429）。
 */
async function matchAndCheck(user: SgUser, modelConfig: SgModel): Promise<void> {
    if (user.type === UserType.ROOT) {
        return;
    }
    const { nonVendorRules } = await getEnabledRules();
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
 * root 用户直接旁路。rate_limit 传 failoverEligible = true（超限视为该上游繁忙，可切换其它供应商）。
 */
async function matchAndCheckVendor(user: SgUser, modelConfig: SgModel, vendor: SgVendor): Promise<void> {
    if (user.type === UserType.ROOT) {
        return;
    }
    const { vendorRules } = await getEnabledRules();
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

export default {
    matchAndCheck,
    matchAndCheckVendor,
    validateRule,
    invalidateCache,
};
