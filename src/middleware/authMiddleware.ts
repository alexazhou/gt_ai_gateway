import { MiddlewareHandler } from "hono";
import { authenticateAdmin } from "./authUtil";

/**
 * 管理端路由鉴权（admin / root）。
 * 鉴权逻辑统一在 authUtil.authenticateAdmin：两个中间件双挂时不会重复查库。
 */
const requireAdmin: MiddlewareHandler = async (c, next) => {
    const { response } = await authenticateAdmin(c);
    if (response) {
        return response;
    }
    await next();
};

export default { requireAdmin };
