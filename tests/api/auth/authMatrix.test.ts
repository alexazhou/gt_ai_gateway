import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import mockHelper from "../../helpers/mockHelper";
import { setupAdminUser } from "../../globalSetup";
import config from "../../config";

/**
 * P2-18：鉴权去重后的「矩阵回归」。
 *
 * 背景：`authMiddleware.requireAdmin` 与 `tenantScopeMiddleware.requireTenantAdmin` 原本各抄了一份
 * 完全相同的「Bearer 解析 → 查 user → disabled/admin 判定」，两份实现容易只改一份：
 * 结果就是「同一类 token 在 /status.json 能过、在 /user/list.json 却过不了」这种口径漂移。
 * 现在两者共用 `authUtil.authenticateAdmin`，本用例用**同一组 token 打两条不同中间件保护的路由**，
 * 逐条比对状态码与文案，任何一处未来被单独改动都会在这里翻红。
 *
 * 401 与 403 的区别也在这里钉死：
 * - 没带/带错凭证 → 401（身份未知）
 * - 身份有效但被停用 / 非管理员 → 403（身份已知，权限不够）
 */

/** requireAdmin 保护（全局控制面） */
const GLOBAL_ADMIN_ROUTE = "/status.json";
/** requireTenantAdmin 保护（租户业务面） */
const TENANT_ADMIN_ROUTE = "/user/list.json";

let adminToken: string;
let normalUserToken: string;
let disabledUserToken: string;

async function hit(route: string, token?: string) {
    return requestHelper.get(route, token);
}

/** 需要精确控制 Authorization 头时用原生 fetch（requestHelper 只会拼 `Bearer ${token}`） */
async function rawGet(route: string, headers: Record<string, string>) {
    const response = await fetch(`${config.SERVER_CONFIG.baseUrl}${route}`, { headers });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** 同一凭证在两个中间件下必须给出一致的判定（状态码 + error 文案） */
async function expectConsistent(token: string | undefined, status: number, errorMatcher?: string | RegExp) {
    const globalRes = await hit(GLOBAL_ADMIN_ROUTE, token);
    const tenantRes = await hit(TENANT_ADMIN_ROUTE, token);

    expect(globalRes.status, `${GLOBAL_ADMIN_ROUTE} 应返回 ${status}`).toBe(status);
    expect(tenantRes.status, `${TENANT_ADMIN_ROUTE} 应返回 ${status}`).toBe(status);
    expect(tenantRes.status, "两套中间件判定必须一致（P2-18 去重的意义）").toBe(globalRes.status);

    if (errorMatcher) {
        const matcher = typeof errorMatcher === "string" ? new RegExp(errorMatcher, "i") : errorMatcher;
        expect(String(JSON.stringify(globalRes.body))).toMatch(matcher);
        expect(String(JSON.stringify(tenantRes.body))).toMatch(matcher);
    }
    return { globalRes, tenantRes };
}

describe("P2-18 鉴权矩阵（requireAdmin vs requireTenantAdmin）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const normal = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        expect(normal.status).toBe(200);
        normalUserToken = normal.body.token;

        const disabled = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        expect(disabled.status).toBe(200);
        disabledUserToken = disabled.body.token;
        await dbHelper.execute(`UPDATE user SET status = 'disabled' WHERE id = ${disabled.body.id}`);
    }, 60000);

    it("完全不带 Authorization：两条路由都 401，文案一致", async () => {
        await expectConsistent(undefined, 401, "Authorization header is missing or invalid");
    });

    it("凭证方案不对（Token xxx 而非 Bearer）：401，两条路由一致", async () => {
        const globalRes = await rawGet(GLOBAL_ADMIN_ROUTE, { Authorization: "Token abc" });
        const tenantRes = await rawGet(TENANT_ADMIN_ROUTE, { Authorization: "Token abc" });
        expect(globalRes.status).toBe(401);
        expect(tenantRes.status).toBe(401);
        expect(JSON.stringify(globalRes.body)).toMatch(/missing or invalid/i);
        expect(JSON.stringify(tenantRes.body)).toMatch(/missing or invalid/i);
    });

    it("Bearer 后面是空 token：401，两条路由一致", async () => {
        const globalRes = await rawGet(GLOBAL_ADMIN_ROUTE, { Authorization: "Bearer " });
        const tenantRes = await rawGet(TENANT_ADMIN_ROUTE, { Authorization: "Bearer " });
        expect(globalRes.status).toBe(401);
        expect(tenantRes.status).toBe(401);
    });

    it("伪造 token：401 Invalid token", async () => {
        await expectConsistent("fake-token-does-not-exist", 401, "Invalid token");
    });

    it("有效但被停用的用户：403 User disabled（不是 401）", async () => {
        await expectConsistent(disabledUserToken, 403, "User disabled");
    });

    it("普通用户：403 Admin access required", async () => {
        await expectConsistent(normalUserToken, 403, "Admin access required");
    });

    it("管理员：两条路由都放行", async () => {
        const globalRes = await hit(GLOBAL_ADMIN_ROUTE, adminToken);
        const tenantRes = await hit(TENANT_ADMIN_ROUTE, adminToken);

        expect(globalRes.status).toBe(200);
        expect(tenantRes.status).toBe(200);
        expect(tenantRes.body, "管理员应能拿到用户列表").toBeTruthy();
    });

    it("401/403 响应体是 JSON（不是 HTML/纯文本），前端才能统一处理", async () => {
        const unauthorized = await hit(GLOBAL_ADMIN_ROUTE, undefined);
        const forbidden = await hit(GLOBAL_ADMIN_ROUTE, normalUserToken);

        expect(typeof unauthorized.body).toBe("object");
        expect(typeof forbidden.body).toBe("object");
        expect(unauthorized.body).toHaveProperty("error");
        expect(forbidden.body).toHaveProperty("error");
    });
});
