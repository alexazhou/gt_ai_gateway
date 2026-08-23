import { Context } from "hono";
import ruleManager from "../manager/ruleManager";
import ruleService from "../service/ruleService";
import customError from "../customError";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";


async function listRules(c: Context) {
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const result = await ruleManager.listRules({
        keyword: query.keyword,
        pageSize,
        offset,
    });
    return c.json(createListResponse(result.list, result.total));
}


async function getRule(c: Context) {
    const ruleId = parseInt(c.req.param("id"), 10);
    if (isNaN(ruleId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const rule = await ruleManager.findById(ruleId);
    if (!rule) {
        throw new customError.NotFoundError("Rule not found");
    }

    return c.json(rule);
}


async function createRule(c: Context) {
    const body = await c.req.json();
    ruleService.validateRule(body);

    const rule = await ruleManager.create({
        type: body.type,
        name: body.name ?? "",
        scope: body.scope,
        config: body.config ?? {},
        enabled: body.enabled !== undefined ? body.enabled : true,
    });
    return c.json(rule);
}


async function updateRule(c: Context) {
    const ruleId = parseInt(c.req.param("id"), 10);
    if (isNaN(ruleId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const body = await c.req.json();
    ruleService.validateRule(body);

    // 仅更新请求体出现的字段，避免未传字段被置空
    const updateData: Record<string, any> = {};
    for (const key of ["type", "name", "scope", "config", "enabled"] as const) {
        if (body[key] !== undefined) {
            updateData[key] = body[key];
        }
    }

    const updated = await ruleManager.update(ruleId, updateData);
    if (!updated) {
        throw new customError.NotFoundError("Rule not found");
    }
    return c.json(updated);
}


async function deleteRule(c: Context) {
    const ruleId = Number(c.req.param("id"));
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
        throw new customError.AppError("Invalid ID format");
    }

    const deleted = await ruleManager.deleteRule(ruleId);
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
