import SgRule from "../model/sgRule";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";
import customError from "../customError";

interface RuleListOptions {
    keyword?: string;
    pageSize: number;
    offset: number;
}

// 规则 CRUD 后的缓存失效监听器（ruleService 注册），避免 ruleManager 反向依赖 ruleService 造成循环引用。
// 删除/修改后规则需即时生效，这里用订阅回调在写入后通知缓存失效。
type InvalidateListener = () => void;
const invalidateListeners: InvalidateListener[] = [];

function onInvalidate(listener: InvalidateListener): void {
    invalidateListeners.push(listener);
}

function notifyInvalidate(): void {
    for (const listener of invalidateListeners) {
        try {
            listener();
        } catch (e) {
            console.error("[ruleManager] Cache invalidate listener failed:", e);
        }
    }
}


// 「本租户规则 ∪ main 租户共享规则」候选条件
function ruleScopeCondition(tenantId: number, mainTenantId: number): string {
    return `(tenant_id = ${Number(tenantId)} OR (tenant_id = ${Number(mainTenantId)} AND cross_tenant = 1))`;
}


/** 规则求值候选：本租户启用规则 ∪ main 共享启用规则（限流计数按 rule.id 全局统计，语义见设计文档） */
async function listEnabled(tenantId: number, mainTenantId: number): Promise<SgRule[]> {
    const rules = await SgRule.query()
        .where("enabled", 1)
        .whereRaw(ruleScopeCondition(tenantId, mainTenantId))
        .get();
    return rules.all();
}


async function findById(ruleId: number): Promise<SgRule | null> {
    return await SgRule.query().find(ruleId);
}


async function findByIdInTenant(ruleId: number, tenantId: number, mainTenantId: number): Promise<SgRule | null> {
    return await SgRule.query()
        .where("id", ruleId)
        .whereRaw(ruleScopeCondition(tenantId, mainTenantId))
        .first();
}


async function listRules(options: RuleListOptions, scope?: TenantScope) {
    const query = SgRule.query().orderBy("id", "desc");
    if (scope) {
        query.whereRaw(ruleScopeCondition(scope.tenantId, scope.mainTenantId));
    }
    if (options.keyword) {
        query.where("name", "like", `%${options.keyword}%`);
    }

    const total = Number(await query.clone().count() || 0);
    const rules = await query.limit(options.pageSize).offset(options.offset).get();
    return {
        list: rules.all(),
        total,
    };
}


async function create(data: Record<string, any>, tenantId: number): Promise<SgRule> {
    const rule = await SgRule.query().create({
        ...data,
        tenant_id: tenantId,
    });
    notifyInvalidate();
    return rule;
}


async function update(ruleId: number, data: Record<string, any>, scope: TenantScope): Promise<SgRule | null> {
    const rule = await findByIdInTenant(ruleId, scope.tenantId, scope.mainTenantId);
    if (!rule) {
        return null;
    }
    assertWritable(rule, scope);
    await rule.update(data);
    notifyInvalidate();
    return rule;
}


async function deleteRule(ruleId: number, scope: TenantScope): Promise<boolean> {
    const rule = await findByIdInTenant(ruleId, scope.tenantId, scope.mainTenantId);
    if (!rule) {
        return false;
    }
    assertWritable(rule, scope);
    await rule.delete();
    notifyInvalidate();
    return true;
}


/** 共享规则只读：非属主租户（非 main 视角编辑 main 共享规则）一律 403 */
function assertWritable(rule: SgRule, scope: TenantScope): void {
    if (rule.tenant_id !== scope.tenantId) {
        throw new customError.AppError("Shared rule is read-only", 403);
    }
}

export default {
    listEnabled,
    findById,
    findByIdInTenant,
    listRules,
    create,
    update,
    deleteRule,
    onInvalidate,
};
