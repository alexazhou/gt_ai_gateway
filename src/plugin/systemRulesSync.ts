import { RuleType } from "../constants";
import SgRule from "../model/sgRule";
import ruleManager from "../manager/ruleManager";
import configService from "../service/configService";
import tenantService from "../service/tenantService";
import { RULE_SOURCE, SYSTEM_PLUGIN_RULES, SystemPluginRuleDefinition } from "./systemRules";

/**
 * 系统规则的运行期生成 / 纠偏（方案见
 * `shared/gateway-system-rules-init-design/design.md`，B 方案）。
 *
 * 为什么不再由迁移预置：`name / priority / note / plugin / pluginConfig` 全是
 * `src/plugin/systemRules.ts` 里的代码资产，写进 SQL 就固化——改一句文案要再加一条迁移，
 * 而且 SQL 与 TS 必然漂移（只能靠测试钉住）。现在**迁移只做结构 + 存量配置搬迁**，
 * 系统规则的首次插入与后续维护都走这里，TS 常量是唯一真源。
 *
 * 语义约束（拍板见设计文档 §0.1）：
 * - **`enabled` 永不在这里被改写**：它是用户运行期开关（「高级设置 → 请求处理」经
 *   `ruleManager.setSystemRuleEnabled` 写入）。只有当行不存在、需要新建时，才按该规则
 *   对应配置项的**当前值**取初值（有配置行用行值，没有用后端默认值）。
 * - 行被误删后重建会回到配置当前值（`session_header` 默认 false ⇒ 重建后是关的），已拍板接受。
 * - 只维护 **main 租户**一套：系统规则 `cross_tenant = 1`，按 `RULE_SCOPE_SQL`
 *   （`tenant_id = ? OR (tenant_id = main AND cross_tenant = 1)`）对所有租户生效。
 * - 失败即硬失败（不吞异常、不降级成 warn）：规则缺失会让插件链路整体不执行，
 *   静默带病服务比启动失败更难排查。
 */

export interface EnsureSystemRulesResult {
    created: number;
    updated: number;
    unchanged: number;
}

/** 系统规则在库里的固定展示字段（pluginConfig 为空对象；scope 恒为 const true） */
function desiredFields(definition: SystemPluginRuleDefinition): Record<string, unknown> {
    return {
        type: RuleType.PLUGIN,
        name: definition.name,
        priority: definition.priority,
        source: RULE_SOURCE.SYSTEM,
        cross_tenant: 1,
        scope: { type: "const", values: [true] },
        config: { plugin: definition.plugin, pluginConfig: definition.pluginConfig },
        note: definition.note,
    };
}

/** 这些字段是「代码资产」，与常量不一致就要纠偏；`enabled / tenant_id / biz_id` 不在此列 */
const DRIFT_FIELDS = ["type", "name", "priority", "source", "cross_tenant", "scope", "config", "note"] as const;

/**
 * 比较库中现值与期望值，返回需要更新的字段。
 * json 列（scope / config）在模型层已被 cast 成对象，用序列化后比较避免键序/引用差异误判。
 */
function computeDrift(rule: SgRule, desired: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const field of DRIFT_FIELDS) {
        const current = (rule as unknown as Record<string, unknown>)[field];
        const expected = desired[field];
        const same = (field === "scope" || field === "config")
            ? JSON.stringify(current ?? null) === JSON.stringify(expected ?? null)
            : current === expected;
        if (!same) {
            patch[field] = expected;
        }
    }
    return patch;
}

/**
 * 保证四条系统规则存在且字段与常量一致。幂等：第二次调用应得到
 * `{ created: 0, updated: 0, unchanged: 4 }`。
 *
 * 调用点（务必在「任何请求读规则之前」）：
 * - node + sqlite / MySQL：`ormService.init()` 的 `applyStartupMigrations` 之后
 * - worker(D1)：`ormService.connectWorker()` → `_doConnectWorker()`（已有一请求一次的锁）
 */
export async function ensureSystemRules(): Promise<EnsureSystemRulesResult> {
    const tenantId = await tenantService.getMainTenantId();
    const result: EnsureSystemRulesResult = { created: 0, updated: 0, unchanged: 0 };

    for (const definition of SYSTEM_PLUGIN_RULES) {
        const desired = desiredFields(definition);
        let existing = await SgRule.query().where("biz_id", definition.bizId).first();

        if (!existing) {
            // 新建行才取配置初值；已存在的行永远不会因为这里而改 enabled
            const enabled = (await configService.getConfig(definition.configKey)).getBoolean();
            try {
                await SgRule.query().create({
                    ...desired,
                    enabled,
                    tenant_id: tenantId,
                    biz_id: definition.bizId,
                });
                result.created += 1;
                continue;
            } catch (error) {
                // 多副本 / 多 isolate 同时首启：唯一索引（biz_id）会让其中一个失败。
                // 不按错误文案判断方言差异，直接复查行是否已被别人建好。
                existing = await SgRule.query().where("biz_id", definition.bizId).first();
                if (!existing) {
                    throw new Error(
                        `[systemRules] ensure failed: bizId=${definition.bizId} tenant=${tenantId} ${String(error)}`,
                    );
                }
            }
        }

        const patch = computeDrift(existing, desired);
        if (Object.keys(patch).length === 0) {
            result.unchanged += 1;
            continue;
        }
        await existing.update(patch);
        result.updated += 1;
    }

    // 走 ruleManager 的失效通知（ruleService 在其中注册了规则缓存清理），
    // 否则首请求可能读到 ensure 之前的缓存快照
    ruleManager.notifyInvalidate();

    const line = `[systemRules] ensure created=${result.created} updated=${result.updated} unchanged=${result.unchanged}`;
    if (result.created + result.updated > 0) {
        console.log(line);
    } else {
        console.debug(line);
    }
    return result;
}

export default { ensureSystemRules };
