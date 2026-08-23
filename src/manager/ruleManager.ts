import SgRule from "../model/sgRule";

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


async function listEnabled(): Promise<SgRule[]> {
    const rules = await SgRule.query().where("enabled", 1).get();
    return rules.all();
}


async function findById(ruleId: number): Promise<SgRule | null> {
    return await SgRule.query().find(ruleId);
}


async function listRules(options: RuleListOptions) {
    const query = SgRule.query().orderBy("id", "desc");
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


async function create(data: Record<string, any>): Promise<SgRule> {
    const rule = await SgRule.query().create(data);
    notifyInvalidate();
    return rule;
}


async function update(ruleId: number, data: Record<string, any>): Promise<SgRule | null> {
    const rule = await SgRule.query().find(ruleId);
    if (!rule) {
        return null;
    }
    await rule.update(data);
    notifyInvalidate();
    return rule;
}


async function deleteRule(ruleId: number): Promise<boolean> {
    const rule = await SgRule.query().find(ruleId);
    if (!rule) {
        return false;
    }
    await rule.delete();
    notifyInvalidate();
    return true;
}

export default {
    listEnabled,
    findById,
    listRules,
    create,
    update,
    deleteRule,
    onInvalidate,
};
