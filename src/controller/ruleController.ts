import { Context } from "hono";
import ruleManager from "../manager/ruleManager";
import ruleService from "../service/ruleService";
import customError from "../customError";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";


// 全局共享规则仅 main 租户可配置：非 main 视角置 cross_tenant = 1 时拒绝
function assertCrossTenantAllowed(scope: any, crossTenant: unknown): void {
    if ((crossTenant === true || crossTenant === 1) && scope.tenantId !== scope.mainTenantId) {
        throw new customError.AppError("Only rules in the main tenant can be globally shared", 400);
    }
}


async function listRules(c: Context) {
    const scope = c.get("tenantScope")!;
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const result = await ruleManager.listRules({
        keyword: query.keyword,
        pageSize,
        offset,
    }, scope);
    return c.json(createListResponse(result.list, result.total));
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

    const rule = await ruleManager.create({
        type: body.type,
        name: body.name ?? "",
        scope: body.scope,
        config: body.config ?? {},
        enabled: body.enabled !== undefined ? body.enabled : true,
        cross_tenant: body.cross_tenant === true || body.cross_tenant === 1 ? 1 : 0,
    }, scope.tenantId);
    return c.json(rule);
}


async function updateRule(c: Context) {
    const scope = c.get("tenantScope")!;
    const ruleId = parseInt(c.req.param("id"), 10);
    if (isNaN(ruleId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const body = await c.req.json();
    ruleService.validateRule(body);
    assertCrossTenantAllowed(scope, body.cross_tenant);

    // 仅更新请求体出现的字段，避免未传字段被置空
    const updateData: Record<string, any> = {};
    for (const key of ["type", "name", "scope", "config", "enabled", "cross_tenant"] as const) {
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
    getRule,
    createRule,
    updateRule,
    deleteRule,
};
