import SgTenant from "../model/sgTenant";
import { DEFAULT_TENANT_NAME } from "../constants";
import tenantManager from "../manager/tenantManager";
import userManager from "../manager/userManager";
import modelManager from "../manager/modelManager";
import vendorManager from "../manager/vendorManager";
import customError from "../customError";

// main 租户 id 缓存：main 不可删、名字不可改，一次加载后稳定（跨请求复用，降低热路径查询成本）。
// 测试清理用 clearMainTenantCache 重置。
let mainTenantIdCache: number | null = null;


async function getMainTenant(): Promise<SgTenant> {
    const tenant = await tenantManager.findByName(DEFAULT_TENANT_NAME);
    if (!tenant) {
        throw new customError.AppError(`Main tenant "${DEFAULT_TENANT_NAME}" not found`, 500);
    }
    return tenant;
}


async function getMainTenantId(): Promise<number> {
    if (mainTenantIdCache != null) {
        return mainTenantIdCache;
    }
    const tenant = await getMainTenant();
    mainTenantIdCache = tenant.id;
    return tenant.id;
}


function clearMainTenantCache(): void {
    mainTenantIdCache = null;
}


async function createTenant(name: string, description?: string | null): Promise<SgTenant> {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) {
        throw new customError.AppError("Tenant name is required", 400);
    }
    if (trimmed === DEFAULT_TENANT_NAME) {
        throw new customError.AppError(`Tenant name "${DEFAULT_TENANT_NAME}" is reserved`, 400);
    }

    const existing = await tenantManager.findByName(trimmed);
    if (existing) {
        throw new customError.AppError(`Tenant name "${trimmed}" already exists`, 400);
    }

    return await tenantManager.create({ name: trimmed, description: description ?? null });
}


async function updateTenant(tenantId: number, data: { name?: string; description?: string | null }): Promise<SgTenant> {
    const tenant = await tenantManager.findById(tenantId);
    if (!tenant) {
        throw new customError.NotFoundError("Tenant not found");
    }

    const updateData: Record<string, any> = {};
    if (data.name !== undefined) {
        const trimmed = String(data.name).trim();
        if (!trimmed) {
            throw new customError.AppError("Tenant name is required", 400);
        }
        if (tenant.name === DEFAULT_TENANT_NAME || trimmed === DEFAULT_TENANT_NAME) {
            throw new customError.AppError(`Main tenant name cannot be changed`, 400);
        }
        const dup = await tenantManager.findByName(trimmed);
        if (dup && dup.id !== tenantId) {
            throw new customError.AppError(`Tenant name "${trimmed}" already exists`, 400);
        }
        updateData.name = trimmed;
    }
    if (data.description !== undefined) {
        updateData.description = data.description ?? null;
    }

    const updated = await tenantManager.update(tenantId, updateData);
    return updated!;
}


async function deleteTenant(tenantId: number): Promise<void> {
    const tenant = await tenantManager.findById(tenantId);
    if (!tenant) {
        throw new customError.NotFoundError("Tenant not found");
    }
    if (tenant.name === DEFAULT_TENANT_NAME) {
        throw new customError.AppError("Main tenant cannot be deleted", 400);
    }

    // 仅「空租户」（无 user / model / vendor）可删；历史 record / recharge_records 忽略（不可达死数据）
    const refs = await Promise.all([
        userManager.countByTenant(tenantId),
        modelManager.countByTenant(tenantId),
        vendorManager.countByTenant(tenantId),
    ]);
    const totalRefs = refs[0] + refs[1] + refs[2];
    if (totalRefs > 0) {
        throw new customError.AppError(
            `Tenant "${tenant.name}" is not empty (has ${totalRefs} user/model/vendor), cannot delete`,
            400,
        );
    }

    await tenantManager.deleteById(tenantId);
}

export default {
    getMainTenant,
    getMainTenantId,
    clearMainTenantCache,
    createTenant,
    updateTenant,
    deleteTenant,
};
