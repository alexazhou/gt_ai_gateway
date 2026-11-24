import { Context } from "hono";
import ruleManager from "../manager/ruleManager";
import ruleService from "../service/ruleService";
import pluginRegistry from "../plugin/pluginRegistry";
import { RULE_SOURCE, type RuleSource } from "../plugin/systemRules";
import customError from "../customError";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";


// 全局共享规则仅 main 租户可配置：非 main 视角置 cross_tenant = 1 时拒绝
function assertCrossTenantAllowed(scope: TenantScope, crossTenant: unknown): void {
    if ((crossTenant === true || crossTenant === 1) && scope.tenantId !== scope.mainTenantId) {
        throw new customError.AppError("Only rules in the main tenant can be globally shared", 400);
    }
}


/** `?source=user|system` 筛选（不传 / 空串 = 全部）；非法值直接 400，不静默忽略 */
function parseSourceFilter(raw: string | undefined): RuleSource | undefined {
    if (raw === undefined || raw === "") {
        return undefined;
    }
    if (raw !== RULE_SOURCE.USER && raw !== RULE_SOURCE.SYSTEM) {
        throw new customError.AppError(`Invalid source filter: ${raw}`);
    }
    return raw;
}


async function listRules(c: Context) {
    const scope = c.get("tenantScope")!;
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const result = await ruleManager.listRules({
        keyword: query.keyword,
        source: parseSourceFilter(query.source),
        pageSize,
        offset,
    }, scope);
    return c.json(createListResponse(result.list, result.total));
}


/**
 * 已注册的请求插件列表（新建「请求插件」规则时的下拉数据源）。
 *
 * 路由注册位置有讲究：必须排在 `/rule/:id` **之前**，否则 `plugins.json` 会被当成 id。
 */
async function listPlugins(c: Context) {
    return c.json(pluginRegistry.describe());
}


async function getRule(c: Context) {
    const scope = c.get("tenantScope")!;
    const ruleId = parseInt(c.req.param("id"), 10);
    if (isNaN(ruleId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const rule = await ruleManager.findByIdInTenant(ruleId, scope.tenantId, scope.mainTenantId);
    if (!rule) {
        throw new customError.NotFoundError("Rule not found");
    }

    return c.json(rule);
}


async function createRule(c: Context) {
    const scope = c.get("tenantScope")!;
    const body = await c.req.json();
    ruleService.validateRule(body);
    assertCrossTenantAllowed(scope, body.cross_tenant);

    // 只接受这几个字段：请求体里的 source / biz_id 一律忽略（系统规则只能由迁移预置、
    // 由高级设置联动，不接受客户端凭空创建），priority 未传则由 DB 默认值 100 兜底
    const createData: Record<string, any> = {
        type: body.type,
        name: body.name ?? "",
        scope: body.scope,
        config: body.config ?? {},
        enabled: body.enabled !== undefined ? body.enabled : true,
        cross_tenant: body.cross_tenant === true || body.cross_tenant === 1 ? 1 : 0,
    };
    if (body.priority !== undefined) {
        createData.priority = body.priority;
    }

    const rule = await ruleManager.create(createData, scope.tenantId);
    return c.json(rule);
}


async function updateRule(c: Context) {
    const scope = c.get("tenantScope")!;
    const ruleId = parseInt(c.req.param("id"), 10);
    if (isNaN(ruleId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const body = await c.req.json();

    // 顺序：先定位规则并判只读（403），再做参数校验（400）。
    // 系统规则的任何一个修改请求都该拿到「只读」而不是「参数非法」——否则调用方会以为
    // 只是自己参数写错，改对了就能改系统规则。
    const existing = await ruleManager.findByIdInTenant(ruleId, scope.tenantId, scope.mainTenantId);
    if (!existing) {
        throw new customError.NotFoundError("Rule not found");
    }
    ruleManager.assertRuleWritable(existing, scope);

    ruleService.validateRule(body);
    assertCrossTenantAllowed(scope, body.cross_tenant);

    // 仅更新请求体出现的字段，避免未传字段被置空；source / biz_id 不在白名单里（不可改）
    const updateData: Record<string, any> = {};
    for (const key of ["type", "name", "scope", "config", "enabled", "cross_tenant", "priority"] as const) {
        if (body[key] !== undefined) {
            updateData[key] = key === "cross_tenant"
                ? (body[key] === true || body[key] === 1 ? 1 : 0)
                : body[key];
        }
    }

    const updated = await ruleManager.update(ruleId, updateData, scope);
    if (!updated) {
        throw new customError.NotFoundError("Rule not found");
    }
    return c.json(updated);
}


async function deleteRule(c: Context) {
    const scope = c.get("tenantScope")!;
    const ruleId = Number(c.req.param("id"));
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
        throw new customError.AppError("Invalid ID format");
    }

    const deleted = await ruleManager.deleteRule(ruleId, scope);
    if (!deleted) {
        throw new customError.NotFoundError("Rule not found");
    }
    return c.json({ success: true });
}

export default {
    listRules,
    listPlugins,
    getRule,
    createRule,
    updateRule,
    deleteRule,
};
