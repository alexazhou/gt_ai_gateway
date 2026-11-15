import { Context } from "hono";
import userService from "../service/userService";
import { UserType, UserStatus } from "../constants";
import { SgUser } from "../model/sgUser";

/**
 * 管理端鉴权（P2-18 去重）。
 *
 * `authMiddleware.requireAdmin` 与 `tenantScopeMiddleware.requireTenantAdmin` 原本各抄了一份
 * 完全相同的逻辑（Bearer 解析 → 查 user → disabled / admin 判定），两份容易改漏一份：
 * 比如只给其中一个加了 disabled 校验，就会出现「某类路由能过、另一类不能过」的诡异差异。
 * 统一到这里，两个中间件只负责「失败了返回 response，成功了继续 next」。
 *
 * 返回结构而不是直接抛错：中间件需要把 401/403 以 JSON 响应体返回（不是走 onError 的 LLM 错误格式）。
 */
export interface AdminAuthResult {
    user: SgUser | null;
    response: Response | null;
}

export async function authenticateAdmin(c: Context): Promise<AdminAuthResult> {
    // 两个中间件会双挂（app.use 一次 + 路由声明一次）：user 已注入就不再查库
    let user = (c.get("user") as SgUser | undefined) ?? null;

    if (!user) {
        const authHeader = c.req.header("Authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return { user: null, response: c.json({ error: "Authorization header is missing or invalid" }, 401) };
        }

        const token = authHeader.split(" ")[1];
        user = await userService.getUserByToken(token, c.env.ROOT_TOKEN);
        if (!user) {
            return { user: null, response: c.json({ error: "Invalid token" }, 401) };
        }
    }

    // 禁用用户即使 token 有效也拒绝（403，不是 401：身份是真的，只是被停用）
    if (user.status === UserStatus.DISABLED) {
        return { user: null, response: c.json({ error: "User disabled" }, 403) };
    }

    if (user.type !== UserType.ADMIN && user.type !== UserType.ROOT) {
        return { user: null, response: c.json({ error: "Admin access required" }, 403) };
    }

    c.set("user_type", user.type);
    // 注入完整 user（含 tenant_id），供租户作用域解析使用
    c.set("user", user);
    return { user, response: null };
}


export default { authenticateAdmin };
