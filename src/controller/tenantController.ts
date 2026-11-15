import { Context } from "hono";
import tenantManager from "../manager/tenantManager";
import tenantService from "../service/tenantService";
import configService from "../service/configService";
import customError from "../customError";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";


// 租户管理系统管理员专用（root，或归属 main 租户的 admin）：非系统管理员一律 403
function assertSystemAdmin(c: Context): void {
    if (!c.get("tenantScope")?.isSystemAdmin) {
        throw new customError.AppError("System administrator access required", 403);
    }
}


// 功能开关关闭时租户「管理写操作」禁用（list / get 仍允许系统管理员查看租户本身）
async function assertMultiTenantEnabled(): Promise<void> {
    if (!(await configService.isMultiTenantEnabled())) {
        throw new customError.AppError("Multi-tenant isolation is disabled", 400);
    }
}


async function listTenants(c: Context) {
    assertSystemAdmin(c);
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const result = await tenantManager.list({
        keyword: query.keyword,
        pageSize,
        offset,
    });
    return c.json(createListResponse(result.list, result.total));
}


async function getTenant(c: Context) {
    assertSystemAdmin(c);
    const tenantId = parseInt(c.req.param("id"), 10);
    if (isNaN(tenantId)) {
        throw new customError.AppError("Invalid ID format", 400);
    }
    const tenant = await tenantManager.findById(tenantId);
    if (!tenant) {
        throw new customError.NotFoundError("Tenant not found");
    }
    return c.json(tenant);
}


async function createTenant(c: Context) {
    assertSystemAdmin(c);
    await assertMultiTenantEnabled();
    const body = await c.req.json();
    const tenant = await tenantService.createTenant(body.name, body.description);
    return c.json(tenant);
}


async function updateTenant(c: Context) {
    assertSystemAdmin(c);
    await assertMultiTenantEnabled();
    const tenantId = parseInt(c.req.param("id"), 10);
    if (isNaN(tenantId)) {
        throw new customError.AppError("Invalid ID format", 400);
    }
    const body = await c.req.json();
    const tenant = await tenantService.updateTenant(tenantId, {
        name: body.name,
        description: body.description,
    });
    return c.json(tenant);
}


async function deleteTenant(c: Context) {
    assertSystemAdmin(c);
    await assertMultiTenantEnabled();
    const tenantId = parseInt(c.req.param("id"), 10);
    if (isNaN(tenantId)) {
        throw new customError.AppError("Invalid ID format", 400);
    }
    await tenantService.deleteTenant(tenantId);
    return c.json({ success: true });
}

export default {
    listTenants,
    getTenant,
    createTenant,
    updateTenant,
    deleteTenant,
};
