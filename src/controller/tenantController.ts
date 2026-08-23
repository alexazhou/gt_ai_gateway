import { Context } from "hono";
import { UserType } from "../constants";
import tenantManager from "../manager/tenantManager";
import tenantService from "../service/tenantService";
import configService from "../service/configService";
import customError from "../customError";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";


// 租户管理 root 专用：非 root 一律 403
function assertRoot(c: Context): void {
    if (c.get("user_type") !== UserType.ROOT) {
        throw new customError.AppError("Root access required", 403);
    }
}


// 功能开关关闭时租户「管理写操作」禁用（list / get 仍允许 root 查看租户本身）
async function assertMultiTenantEnabled(): Promise<void> {
    if (!(await configService.isMultiTenantEnabled())) {
        throw new customError.AppError("Multi-tenant isolation is disabled", 400);
    }
}


async function listTenants(c: Context) {
    assertRoot(c);
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
    assertRoot(c);
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
    assertRoot(c);
    await assertMultiTenantEnabled();
    const body = await c.req.json();
    const tenant = await tenantService.createTenant(body.name, body.description);
    return c.json(tenant);
}


async function updateTenant(c: Context) {
    assertRoot(c);
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
    assertRoot(c);
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
