import SgTenant from "../model/sgTenant";
import { SgUser } from "../model/sgUser";
import { DEFAULT_TENANT_NAME, UserType } from "../constants";
import tenantManager from "../manager/tenantManager";
import userManager from "../manager/userManager";
import modelManager from "../manager/modelManager";
import vendorManager from "../manager/vendorManager";
import configService from "./configService";
import customError from "../customError";

/**
 * 请求的租户作用域：数据隔离的解析结果。manager 据此在查询条件中收敛，禁止先全局按 ID 查询再在
 * controller 判断归属。middleware 只负责解析注入，不可由请求 body 覆盖。
 */
export interface TenantScope {
    tenantId: number;
    /** main 租户 id：构建「本租户 ∪ main 共享模型/规则」候选条件用 */
    mainTenantId: number;
    /**
     * 系统管理员：root，或归属 main 租户的 admin。多租户下二者**管理权限**完全等价
     * （租户管理 / 跨租户视角 / 多租户开关）。
     * 判据只看 user.tenant_id，与多租户隔离开关状态无关。
     * 与 LLM 调用权限无关：所有用户（含 root）均受限流 / 访问控制规则约束。
     */
    isSystemAdmin: boolean;
    multiTenantEnabled: boolean;
}

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


// X-Tenant-ID 支持租户 id（数字）或名字（字符串）
async function resolveTenantByIdentifier(identifier: string): Promise<SgTenant | null> {
    const trimmed = String(identifier ?? "").trim();
    if (!trimmed) {
        return null;
    }
    const numeric = parseInt(trimmed, 10);
    if (!isNaN(numeric) && String(numeric) === trimmed) {
        return await tenantManager.findById(numeric);
    }
    return await tenantManager.findByName(trimmed);
}


// 系统管理员判定：root 全部是；admin 须归属 main 租户。normal 一律不是。
// 判据只看 user.tenant_id（不看解析出的视角租户），故隔离开关闭时归属其它租户的 admin 仍不是系统管理员。
function computeIsSystemAdmin(user: SgUser | undefined, mainTenantId: number): boolean {
    if (!user) {
        return false;
    }
    if (user.type === UserType.ROOT) {
        return true;
    }
    return user.type === UserType.ADMIN && user.tenant_id === mainTenantId;
}


// 与产品文档「请求的租户区分」一致。供管理端中间件与 LLM 调用路径共用。
// - 功能开关关闭：一律 main；显式指定非 main 租户时报错（不静默回退）
// - 功能开关开启：显式指定 X-Tenant-ID → 用该租户（系统管理员可任意、不存在 400；非系统管理员必须等于自身 tenant_id，否则 403）；
//   未显式指定 → 非系统管理员用自身租户、系统管理员缺省 main
async function resolveScopeForUser(user: SgUser | undefined, header?: string): Promise<TenantScope> {
    const multiTenantEnabled = await configService.isMultiTenantEnabled();
    const mainId = await getMainTenantId();
    const isSystemAdmin = computeIsSystemAdmin(user, mainId);

    if (!multiTenantEnabled) {
        if (header && header.trim() !== "") {
            const specified = await resolveTenantByIdentifier(header);
            if (!specified || specified.id !== mainId) {
                throw new customError.AppError("Multi-tenant isolation is disabled", 400);
            }
        }
        return { tenantId: mainId, mainTenantId: mainId, isSystemAdmin, multiTenantEnabled: false };
    }

    if (header && header.trim() !== "") {
        const specified = await resolveTenantByIdentifier(header);
        if (!specified) {
            throw new customError.AppError("Tenant not found", 400);
        }
        if (!isSystemAdmin && specified.id !== user?.tenant_id) {
            throw new customError.AppError("Tenant mismatch: you can only operate within your own tenant", 403);
        }
        return { tenantId: specified.id, mainTenantId: mainId, isSystemAdmin, multiTenantEnabled: true };
    }

    if (isSystemAdmin) {
        return { tenantId: mainId, mainTenantId: mainId, isSystemAdmin, multiTenantEnabled: true };
    }
    return { tenantId: user?.tenant_id ?? mainId, mainTenantId: mainId, isSystemAdmin, multiTenantEnabled: true };
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
    resolveScopeForUser,
    createTenant,
    updateTenant,
    deleteTenant,
};
