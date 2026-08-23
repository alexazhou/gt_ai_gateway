import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import userFixtures from "../../fixtures/userFixtures";
import vendorFixtures from "../../fixtures/vendorFixtures";

const ROOT_TOKEN = "root-token-123";
const adminToken = userFixtures.ADMIN_TOKEN;

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

async function enableMultiTenant(): Promise<void> {
    const res = await scoped("PUT", "/config.json", ROOT_TOKEN, undefined, { multi_tenant_enabled: "true" });
    expect(res.status).toBe(200);
}

describe("Tenant isolation API", () => {
    let tenantBId: number;
    let tenantCId: number;
    let bAdminToken = "b-admin-token";

    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        await enableMultiTenant();

        const b = await scoped("POST", "/tenant.json", ROOT_TOKEN, undefined, { name: "tenant-b" });
        expect(b.status).toBe(200);
        tenantBId = b.body.id;

        const c = await scoped("POST", "/tenant.json", ROOT_TOKEN, undefined, { name: "tenant-c" });
        tenantCId = c.body.id;

        // tenant-b 的管理员（root 用 X-Tenant-ID 视角创建）
        const userRes = await scoped("POST", "/user/create.json", ROOT_TOKEN, tenantBId, {
            name: "b-admin",
            token: bAdminToken,
            type: "admin",
        });
        expect(userRes.status).toBe(200);
    });

    it("root 可列表租户；main + tenant-b + tenant-c 都在列表", async () => {
        const list = await scoped("GET", "/tenant.json", ROOT_TOKEN);
        expect(list.status).toBe(200);
        const names = list.body.list.map((t: any) => t.name);
        expect(names).toContain("main");
        expect(names).toContain("tenant-b");
        expect(names).toContain("tenant-c");
    });

    it("admin 访问租户管理端点 → 403", async () => {
        const res = await scoped("GET", "/tenant.json", adminToken);
        expect(res.status).toBe(403);
    });

    it("main 租户不可删；重名租户创建被拒", async () => {
        const list = await scoped("GET", "/tenant.json", ROOT_TOKEN);
        const mainId = list.body.list.find((t: any) => t.name === "main").id;

        const delMain = await scoped("DELETE", `/tenant/${mainId}`, ROOT_TOKEN);
        expect(delMain.status).toBe(400);

        const dup = await scoped("POST", "/tenant.json", ROOT_TOKEN, undefined, { name: "tenant-b" });
        expect(dup.status).toBe(400);
    });

    it("非空租户不可删；空租户可删", async () => {
        // tenant-b 有用户（b-admin）→ 非空不可删
        const delB = await scoped("DELETE", `/tenant/${tenantBId}`, ROOT_TOKEN);
        expect(delB.status).toBe(400);

        // tenant-c 为空 → 可删
        const delC = await scoped("DELETE", `/tenant/${tenantCId}`, ROOT_TOKEN);
        expect(delC.status).toBe(200);
    });

    it("admin 显式指定非自身租户 → 403；root 指定不存在租户 → 400", async () => {
        const mismatch = await scoped("GET", "/user/list.json", adminToken, tenantBId);
        expect(mismatch.status).toBe(403);

        const notFound = await scoped("GET", "/user/list.json", ROOT_TOKEN, 999999);
        expect(notFound.status).toBe(400);
    });

    it("admin 只见本租户数据：main admin 看不到 tenant-b 的用户", async () => {
        const res = await scoped("GET", "/user/list.json", adminToken);
        expect(res.status).toBe(200);
        const names = res.body.list.map((u: any) => u.name);
        expect(names).toContain("Admin User");
        expect(names).not.toContain("b-admin");
    });

    it("root 切视角查看：X-Tenant-ID 指向 tenant-b 时能看到 b-admin", async () => {
        const res = await scoped("GET", "/user/list.json", ROOT_TOKEN, tenantBId);
        expect(res.status).toBe(200);
        const names = res.body.list.map((u: any) => u.name);
        expect(names).toContain("b-admin");
    });
});

describe("Model cross-tenant sharing", () => {
    let tenantBId: number;
    let bAdminToken = "b-admin-token-2";
    let mainSharedModelId: number;

    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        await enableMultiTenant();

        const b = await scoped("POST", "/tenant.json", ROOT_TOKEN, undefined, { name: "tenant-b" });
        tenantBId = b.body.id;

        // tenant-b 管理员
        await scoped("POST", "/user/create.json", ROOT_TOKEN, tenantBId, {
            name: "b-admin",
            token: bAdminToken,
            type: "admin",
        });

        // main 租户建 vendor + 共享模型（cross_tenant=1）
        const mainVendor = await scoped("POST", "/vendor/create.json", adminToken, undefined, vendorFixtures.VENDOR_FIXTURES.openai());
        expect(mainVendor.status).toBe(200);

        const sharedModel = await scoped("POST", "/model/create.json", adminToken, undefined, {
            name: "shared-gpt",
            enable: true,
            routing_mode: "single",
            routing_config: { upstreams: [{ vendor_id: mainVendor.body.id, enabled: true }] },
            cross_tenant: true,
        });
        expect(sharedModel.status).toBe(200);
        mainSharedModelId = sharedModel.body.id;

        // tenant-b 建 vendor + 私有模型
        const bVendor = await scoped("POST", "/vendor/create.json", ROOT_TOKEN, tenantBId, vendorFixtures.VENDOR_FIXTURES.openai());
        expect(bVendor.status).toBe(200);

        const bModel = await scoped("POST", "/model/create.json", bAdminToken, undefined, {
            name: "b-private",
            enable: true,
            routing_mode: "single",
            routing_config: { upstreams: [{ vendor_id: bVendor.body.id, enabled: true }] },
        });
        expect(bModel.status).toBe(200);
    });

    it("非 main 租户模型列表可见 main 共享模型（只读）", async () => {
        const res = await scoped("GET", "/model/list.json", bAdminToken);
        expect(res.status).toBe(200);
        const models = res.body.list;
        // b 的私有模型 + main 的共享模型都在列表
        expect(models.some((m: any) => m.name === "b-private")).toBe(true);
        expect(models.some((m: any) => m.name === "shared-gpt")).toBe(true);
    });

    it("非 main 租户不能编辑/删除 main 共享模型 → 403", async () => {
        const upd = await scoped("PUT", `/model/${mainSharedModelId}`, bAdminToken, undefined, {
            name: "shared-gpt",
            enable: true,
            routing_mode: "single",
            routing_config: { upstreams: [{ vendor_id: mainSharedModelId, enabled: true }] },
        });
        expect(upd.status).toBe(403);

        const del = await scoped("DELETE", `/model/${mainSharedModelId}`, bAdminToken);
        expect(del.status).toBe(403);
    });

    it("非 main 租户创建模型置 cross_tenant=1 → 400", async () => {
        const res = await scoped("POST", "/model/create.json", bAdminToken, undefined, {
            name: "b-wants-shared",
            enable: true,
            routing_mode: "single",
            routing_config: { upstreams: [{ vendor_id: 1, enabled: true }] },
            cross_tenant: true,
        });
        expect(res.status).toBe(400);
    });

    it("同名模型跨租户共存：tenant-b 可建私有 shared-gpt，与 main 共享 shared-gpt 并存", async () => {
        // b 的 vendor（bVendor 在 beforeAll 创建，这里重新拿一个）
        const bVendor = await scoped("GET", "/vendor/list.json", bAdminToken);
        const bVendorId = bVendor.body.list[0].id;

        const res = await scoped("POST", "/model/create.json", bAdminToken, undefined, {
            name: "shared-gpt",
            enable: true,
            routing_mode: "single",
            routing_config: { upstreams: [{ vendor_id: bVendorId, enabled: true }] },
        });
        expect(res.status).toBe(200);
    });
});
