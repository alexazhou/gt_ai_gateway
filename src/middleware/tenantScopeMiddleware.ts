import { Context, MiddlewareHandler } from "hono";
import { UserType, UserStatus } from "../constants";
import { SgUser } from "../model/sgUser";
import SgTenant from "../model/sgTenant";
import configService from "../service/configService";
import userService from "../service/userService";
import tenantManager from "../manager/tenantManager";
import tenantService from "../service/tenantService";
import customError from "../customError";

/**
 * 请求的租户作用域：数据隔离的解析结果。manager 据此在查询条件中收敛，禁止先全局按 ID 查询再在
 * controller 判断归属。middleware 只负责解析注入，不可由请求 body 覆盖。
 */
export interface TenantScope {
    tenantId: number;
    /** main 租户 id：构建「本租户 ∪ main 共享模型/规则」候选条件用（避免 manager 反向依赖 tenantService） */
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
export async function resolveScopeForUser(user: SgUser | undefined, header?: string): Promise<TenantScope> {
    const multiTenantEnabled = await configService.isMultiTenantEnabled();
    const mainId = await tenantService.getMainTenantId();
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


// SPA 前端路由（/vendor、/model 等，路径不足两段）直接放行给静态/兜底处理，不做租户鉴权
function isApiRoute(path: string): boolean {
    return path.split("/").filter(Boolean).length >= 2;
}

/**
 * 租户业务管理端统一入口：鉴权（admin/root）+ 注入完整 user + 解析租户作用域。
 * 与 authMiddleware.requireAdmin 语义一致（鉴权失败 401/403），成功时 set user + tenantScope。
 * 路由声明上的 requireAdmin 仍保留：user 已注入时短路，不重复查库。
 */
const requireTenantAdmin: MiddlewareHandler = async (c, next) => {
    if (!isApiRoute(c.req.path)) {
        return await next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ error: "Authorization header is missing or invalid" }, 401);
    }
    const token = authHeader.split(" ")[1];
    const user = await userService.getUserByToken(token, c.env.ROOT_TOKEN);
    if (!user) {
        return c.json({ error: "Invalid token" }, 401);
    }
    if (user.status === UserStatus.DISABLED) {
        return c.json({ error: "User disabled" }, 403);
    }
    if (user.type !== UserType.ADMIN && user.type !== UserType.ROOT) {
        return c.json({ error: "Admin access required" }, 403);
    }

    c.set("user", user);
    const scope = await resolveScopeForUser(user, c.req.header("X-Tenant-ID"));
    c.set("tenantScope", scope);
    return await next();
};

/**
 * 仅解析并注入 tenantScope（不做租户鉴权），供全局控制面在 requireAdmin 之后使用。
 * 控制器据 scope.isSystemAdmin 决定是否放行系统管理员专属能力。
 */
const tenantScope: MiddlewareHandler = async (c, next) => {
    const scope = await resolveScopeForUser(c.get("user"), c.req.header("X-Tenant-ID"));
    c.set("tenantScope", scope);
    await next();
};

/**
 * 全局控制面（/config.json、/client-config/*）入口：解析作用域并要求落在 main 视角。
 * 与前端一致（侧边栏「设置」「客户端管理」仅在 main 视角显示）；隔离关闭时 scope 恒为 main，自然放行。
 */
const requireMainView: MiddlewareHandler = async (c, next) => {
    const scope = await resolveScopeForUser(c.get("user"), c.req.header("X-Tenant-ID"));
    if (scope.tenantId !== scope.mainTenantId) {
        return c.json({ error: "This endpoint is only available in the main tenant scope" }, 403);
    }
    c.set("tenantScope", scope);
    return await next();
};

export default { tenantScope, requireMainView, requireTenantAdmin };
