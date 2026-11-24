import SgRule from "../model/sgRule";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";
import customError from "../customError";
import { RULE_PRIORITY_DEFAULT } from "../constants";
import { RULE_SOURCE, type RuleSource } from "../plugin/systemRules";

interface RuleListOptions {
    keyword?: string;
    /** 按来源筛选：user / system（不传 = 全部） */
    source?: RuleSource;
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
//
// P2-08：原来把 tenantId / mainTenantId 内联进 SQL 模板串（当前值都是经解析的整数，不可注入，
// 但这是「靠调用方保证安全」的写法，一旦上游多传个 string 就成了注入面）。改参数绑定，
// 由驱动负责转义，安全性不再依赖调用约定。
const RULE_SCOPE_SQL = "(tenant_id = ? OR (tenant_id = ? AND cross_tenant = 1))";

function ruleScopeBindings(tenantId: number, mainTenantId: number): number[] {
    return [Number(tenantId), Number(mainTenantId)];
}


/**
 * 规则求值候选：本租户启用规则 ∪ main 共享启用规则（限流计数按 rule.id 全局统计，语义见设计文档）。
 *
 * **必须按 `(priority ASC, id ASC)` 返回**：插件规则按这个顺序依次叠加执行，
 * 同阶段同类型的准入检查也按这个顺序。排序放在 SQL 里，调用方不再各自排序（避免谁漏排谁就顺序错）。
 */
async function listEnabled(tenantId: number, mainTenantId: number): Promise<SgRule[]> {
    const rules = await SgRule.query()
        .where("enabled", 1)
        .whereRaw(RULE_SCOPE_SQL, ruleScopeBindings(tenantId, mainTenantId))
        .orderBy("priority", "asc")
        .orderBy("id", "asc")
        .get();
    return rules.all();
}


async function findByBizId(bizId: string): Promise<SgRule | null> {
    return await SgRule.query().where("biz_id", bizId).first();
}

/**
 * 系统规则启停（**仅供高级设置联动**写入）。
 *
 * 为什么单独开一个入口：`update` 会走 `assertRuleWritable` 的用户侧只读保护（系统规则 403），
 * 但高级设置这条路径恰恰是系统规则的合法写入口。这里刻意把可写面收到**只有 `enabled`**——
 * 名字、优先级、scope、插件参数都不许从配置侧改，避免"改个开关顺手改了规则语义"。
 *
 * 返回 null 表示规则不存在（调用方负责报错，不在这里自动创建）。
 */
async function setSystemRuleEnabled(bizId: string, enabled: boolean): Promise<SgRule | null> {
    const rule = await findByBizId(bizId);
    if (!rule) {
        return null;
    }
    await rule.update({ enabled });
    notifyInvalidate();
    return rule;
}


async function findById(ruleId: number): Promise<SgRule | null> {
    return await SgRule.query().find(ruleId);
}


async function findByIdInTenant(ruleId: number, tenantId: number, mainTenantId: number): Promise<SgRule | null> {
    return await SgRule.query()
        .where("id", ruleId)
        .whereRaw(RULE_SCOPE_SQL, ruleScopeBindings(tenantId, mainTenantId))
        .first();
}


async function listRules(options: RuleListOptions, scope?: TenantScope) {
    const query = SgRule.query();
    if (scope) {
        query.whereRaw(RULE_SCOPE_SQL, ruleScopeBindings(scope.tenantId, scope.mainTenantId));
    }
    if (options.keyword) {
        query.where("name", "like", `%${options.keyword}%`);
    }
    if (options.source) {
        query.where("source", options.source);
    }

    const total = Number(await query.clone().count() || 0);
    // 列表按**执行顺序**返回（前端两区展示都要求这个顺序）：priority 升序，同优先级按 id 升序。
    // 原来是 id desc（新建的在最前），优先级引入后那已经不是"执行顺序"，改为执行顺序。
    const rules = await query
        .orderBy("priority", "asc")
        .orderBy("id", "asc")
        .limit(options.pageSize)
        .offset(options.offset)
        .get();
    return {
        list: rules.all(),
        total,
    };
}


/**
 * 去掉值为 `undefined` 的字段。
 *
 * 为什么需要：sutando 会把「存在但为 undefined」的键当成显式 NULL 写进 SQL
 * （实测 `INSERT ... priority ... NULL` → `NOT NULL constraint failed: rule.priority`）。
 * 语义上 undefined = 调用方没提供，应当让 DB 默认值（priority 默认 100 / source 默认 user）
 * 或原值生效，而不是写 NULL。
 */
function withoutUndefined(data: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
            sanitized[key] = value;
        }
    }
    return sanitized;
}


async function create(data: Record<string, any>, tenantId: number): Promise<SgRule> {
    const sanitized = withoutUndefined(data);
    const rule = await SgRule.query().create({
        ...sanitized,
        tenant_id: tenantId,
        // priority / source / biz_id 显式补默认值：sutando 不回读 DB 默认值，
        // 不补的话接口响应里这几个字段是 undefined，前端会以为没生效
        priority: sanitized.priority ?? RULE_PRIORITY_DEFAULT,
        source: sanitized.source ?? RULE_SOURCE.USER,
        biz_id: sanitized.biz_id ?? null,
    });
    notifyInvalidate();
    return rule;
}


async function update(ruleId: number, data: Record<string, any>, scope: TenantScope): Promise<SgRule | null> {
    const rule = await findByIdInTenant(ruleId, scope.tenantId, scope.mainTenantId);
    if (!rule) {
        return null;
    }
    assertRuleWritable(rule, scope);
    await rule.update(withoutUndefined(data));
    notifyInvalidate();
    return rule;
}


async function deleteRule(ruleId: number, scope: TenantScope): Promise<boolean> {
    const rule = await findByIdInTenant(ruleId, scope.tenantId, scope.mainTenantId);
    if (!rule) {
        return false;
    }
    assertRuleWritable(rule, scope);
    await rule.delete();
    notifyInvalidate();
    return true;
}


/**
 * 规则可写性校验（update / delete 共用）。
 *
 * 顺序：**先判系统规则，再判跨租户共享**。设计文档 v3 只写了「修正了系统规则只读校验顺序」，
 * 没写明具体顺序 —— 这里取「先 system」：非 main 租户去改系统规则时应该得到「系统规则只读
 * （去高级设置改）」而不是「共享规则只读」，后者会让人误判成租户权限问题。
 * 两者都是 403，只差文案。
 */
function assertRuleWritable(rule: SgRule, scope: TenantScope): void {
    if (rule.source === RULE_SOURCE.SYSTEM) {
        throw new customError.AppError("System rule is read-only; manage it in Advanced Settings", 403);
    }
    if (rule.tenant_id !== scope.tenantId) {
        throw new customError.AppError("Shared rule is read-only", 403);
    }
}

export default {
    listEnabled,
    findById,
    findByBizId,
    setSystemRuleEnabled,
    findByIdInTenant,
    listRules,
    create,
    update,
    deleteRule,
    assertRuleWritable,
    onInvalidate,
};
