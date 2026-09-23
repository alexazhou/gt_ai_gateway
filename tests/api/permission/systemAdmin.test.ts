import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import userFixtures from "../../fixtures/userFixtures";

const ROOT_TOKEN = "root-token-123";
// main 租户 admin（setupAdminUser 创建时隔离关闭 → tenant_id = main）→ 系统管理员
const mainAdminToken = userFixtures.ADMIN_TOKEN;
const tenantBAdminToken = "b-admin-token-system-admin";

// 带 X-Tenant-ID 的请求
async function scoped(
    method: string,
    path: string,
    token: string,
    tenantId?: number | string,
    body?: any,
): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (tenantId !== undefined) {
        headers["X-Tenant-ID"] = String(tenantId);
    }
    return requestHelper.request(path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

async function setMultiTenant(on: boolean): Promise<void> {
    const res = await scoped("PUT", "/config.json", ROOT_TOKEN, undefined, {
        multi_tenant_enabled: on ? "true" : "false",
    });
    expect(res.status).toBe(200);
}

/**
 * 系统管理员 = root，或归属 main 租户的 admin。
 * 二者在管理端权限完全等价：租户管理、跨租户视角、多租户开关、LLM 规则旁路。
 * 判据只看 user.tenant_id，与多租户隔离开关状态无关。
 */
describe("System administrator (main tenant admin ≡ root)", () => {
    let tenantBId: number;
    let mainTenantId: number;

    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        await setMultiTenant(true);

        const b = await scoped("POST", "/tenant.json", ROOT_TOKEN, undefined, { name: "tenant-b" });
        expect(b.status).toBe(200);
        tenantBId = b.body.id;

        const list = await scoped("GET", "/tenant.json", ROOT_TOKEN);
        mainTenantId = list.body.list.find((t: any) => t.name === "main").id;

        const userRes = await scoped("POST", "/user/create.json", ROOT_TOKEN, tenantBId, {
            name: "b-admin",
            token: tenantBAdminToken,
            type: "admin",
        });
        expect(userRes.status).toBe(200);
    });

    it("/status.json 下发 is_system_admin：main admin 与 root 为 true，tenant-b admin 为 false", async () => {
        const asRoot = await scoped("GET", "/status.json", ROOT_TOKEN);
        expect(asRoot.body.is_system_admin).toBe(true);

        const asMainAdmin = await scoped("GET", "/status.json", mainAdminToken);
        expect(asMainAdmin.body.is_system_admin).toBe(true);

        const asBAdmin = await scoped("GET", "/status.json", tenantBAdminToken);
        expect(asBAdmin.body.is_system_admin).toBe(false);
    });

    it("租户管理：main admin 与 root 同样可 CRUD", async () => {
        const created = await scoped("POST", "/tenant.json", mainAdminToken, undefined, { name: "tenant-by-main-admin" });
        expect(created.status).toBe(200);

        const updated = await scoped("PUT", `/tenant/${created.body.id}`, mainAdminToken, undefined, { description: "edited by main admin" });
        expect(updated.status).toBe(200);

        const removed = await scoped("DELETE", `/tenant/${created.body.id}`, mainAdminToken);
        expect(removed.status).toBe(200);
    });

    it("租户管理：非 main 租户 admin 一律 403", async () => {
        const list = await scoped("GET", "/tenant.json", tenantBAdminToken);
        expect(list.status).toBe(403);

        const create = await scoped("POST", "/tenant.json", tenantBAdminToken, undefined, { name: "tenant-by-b-admin" });
        expect(create.status).toBe(403);

        const del = await scoped("DELETE", `/tenant/${tenantBId}`, tenantBAdminToken);
        expect(del.status).toBe(403);
    });

    it("跨租户视角：main admin 可指定任意租户，非 main admin 不行", async () => {
        const asMainAdmin = await scoped("GET", "/user/list.json", mainAdminToken, tenantBId);
        expect(asMainAdmin.status).toBe(200);
        expect(asMainAdmin.body.list.map((u: any) => u.name)).toContain("b-admin");

        const asBAdmin = await scoped("GET", "/user/list.json", tenantBAdminToken, mainTenantId);
        expect(asBAdmin.status).toBe(403);
    });

    it("多租户开关：main admin 可改；非 main admin 改值 → 403，原值不变", async () => {
        const byMainAdmin = await scoped("PUT", "/config.json", mainAdminToken, undefined, { multi_tenant_enabled: "false" });
        expect(byMainAdmin.status).toBe(200);
        expect(byMainAdmin.body.multi_tenant_enabled).toBe("false");

        // 复原开关（后续用例仍按多租户开启运行）
        await setMultiTenant(true);

        const byBAdmin = await scoped("PUT", "/config.json", tenantBAdminToken, undefined, { multi_tenant_enabled: "false" });
        expect(byBAdmin.status).toBe(403);

        const after = await scoped("GET", "/config.json", ROOT_TOKEN);
        expect(after.body.multi_tenant_enabled).toBe("true");
    });

    it("多租户开关：仅「改值」才需系统管理员，携带原值提交（如只改其它配置）不被连带拒绝", async () => {
        // 隔离关闭时非 main admin 也落在 main 视角（隔离开启时会被 requireMainView 挡在 403）
        await setMultiTenant(false);
        try {
            const sameValue = await scoped("PUT", "/config.json", tenantBAdminToken, undefined, {
                cch_rewrite_enabled: "true",
                multi_tenant_enabled: "false",
            });
            expect(sameValue.status).toBe(200);

            const changed = await scoped("PUT", "/config.json", tenantBAdminToken, undefined, { multi_tenant_enabled: "true" });
            expect(changed.status).toBe(403);
        } finally {
            await setMultiTenant(true);
        }
    });

    it("全局配置读放开、写限 main 视角：非 main admin 读 200 / 写 403", async () => {
        // 读：侧边栏遥测、更新检查与模型表单计费开关都会无条件读取，不限视角
        expect((await scoped("GET", "/config.json", tenantBAdminToken)).status).toBe(200);

        // 写：改其它全局配置项也需 main 视角
        const write = await scoped("PUT", "/config.json", tenantBAdminToken, undefined, { cch_rewrite_enabled: "true" });
        expect(write.status).toBe(403);

        // 对照组：main admin 可写
        expect((await scoped("PUT", "/config.json", mainAdminToken, undefined, { cch_rewrite_enabled: "true" })).status).toBe(200);
    });

    it("客户端配置仅 main 视角可用：非 main admin → 403", async () => {
        const clientConfig = await scoped("GET", "/client-config/status.json", tenantBAdminToken);
        expect(clientConfig.status).toBe(403);

        expect((await scoped("GET", "/client-config/status.json", mainAdminToken)).status).toBe(200);
    });

    it("隔离关闭时，非 main 租户 admin 仍不是系统管理员（判据按 tenant_id，不看解析后的视角）", async () => {
        await setMultiTenant(false);
        try {
            const status = await scoped("GET", "/status.json", tenantBAdminToken);
            expect(status.body.is_system_admin).toBe(false);

            const tenantList = await scoped("GET", "/tenant.json", tenantBAdminToken);
            expect(tenantList.status).toBe(403);

            const changeSwitch = await scoped("PUT", "/config.json", tenantBAdminToken, undefined, { multi_tenant_enabled: "true" });
            expect(changeSwitch.status).toBe(403);
        } finally {
            await setMultiTenant(true);
        }
    });
});
