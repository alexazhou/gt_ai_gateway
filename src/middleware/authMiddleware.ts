import { Context, MiddlewareHandler } from "hono";
import { UserType } from "../constants";
import userService from "../service/userService";
import tenantService, { TenantScope } from "../service/tenantService";
import customError from "../customError";

function extractAdminToken(c: Context): string {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new customError.AppError("Authorization header is missing or invalid", 401);
    }
    return authHeader.split(" ")[1];
}


/**
 * 管理端鉴权 + 租户作用域解析：注入 user / tenantScope 并返回作用域。
 * resolveScopeForUser 在无 X-Tenant-ID 时只读内存缓存，不额外查库，故与鉴权合并为一步。
 */
async function authenticateAdminWithScope(c: Context): Promise<TenantScope> {
    const token = extractAdminToken(c);
    const user = await userService.authenticateByToken(token, c.env.ROOT_TOKEN);

    if (user.type !== UserType.ADMIN && user.type !== UserType.ROOT) {
        throw new customError.AppError("Admin access required", 403);
    }

    c.set("user", user);
    const scope = await tenantService.resolveScopeForUser(user, c.req.header("X-Tenant-ID"));
    c.set("tenantScope", scope);
    return scope;
}


/** 管理端路由鉴权（admin / root），同时注入 user 与 tenantScope。 */
const requireAdmin: MiddlewareHandler = async (c, next) => {
    await authenticateAdminWithScope(c);
    await next();
};


/**
 * 全局控制面（/config.json 写、/client-config/*）入口：鉴权并要求落在 main 视角。
 * 与前端一致（侧边栏「设置」「客户端管理」仅在 main 视角显示）；隔离关闭时 scope 恒为 main，自然放行。
 */
const requireMainView: MiddlewareHandler = async (c, next) => {
    const scope = await authenticateAdminWithScope(c);
    if (scope.tenantId !== scope.mainTenantId) {
        throw new customError.AppError("This endpoint is only available in the main tenant scope", 403);
    }
    await next();
};


/**
 * 租户管理入口：仅系统管理员（root，或归属 main 租户的 admin）。
 * 判据取 scope.isSystemAdmin，与隔离开关状态无关。
 */
const requireSystemAdmin: MiddlewareHandler = async (c, next) => {
    const scope = await authenticateAdminWithScope(c);
    if (!scope.isSystemAdmin) {
        throw new customError.AppError("System administrator access required", 403);
    }
    await next();
};


/**
 * 全局悬空数据清理入口：严格 root 专用。
 * 不能用 scope.isSystemAdmin——它会放行 main 租户的 admin，而这两张附属表没有 tenant_id 列，
 * 按租户收敛会把其他租户仍存活的 payload 当成孤儿删除，故必须限制为 root。
 */
const requireRoot: MiddlewareHandler = async (c, next) => {
    await authenticateAdminWithScope(c);
    const user = c.get("user");
    if (user?.type !== UserType.ROOT) {
        throw new customError.AppError("Root access required", 403);
    }
    await next();
};

export default {
    requireAdmin,
    requireMainView,
    requireSystemAdmin,
    requireRoot,
};
