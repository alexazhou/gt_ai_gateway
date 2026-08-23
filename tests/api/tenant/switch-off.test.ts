import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import userFixtures from "../../fixtures/userFixtures";
import vendorFixtures from "../../fixtures/vendorFixtures";

const ROOT_TOKEN = "root-token-123";
const adminToken = userFixtures.ADMIN_TOKEN;

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

describe("功能开关关闭（逻辑单租户）", () => {
    let tenantBId: number;
    let bModelId: number;

    beforeAll(async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        // 开开关：创建 tenant-b 及数据（产生非 main 数据）
        await setMultiTenant(true);

        const b = await scoped("POST", "/tenant.json", ROOT_TOKEN, undefined, { name: "tenant-b" });
        tenantBId = b.body.id;

        // main 建 vendor；tenant-b 建 vendor + 模型
        await scoped("POST", "/vendor/create.json", adminToken, undefined, vendorFixtures.VENDOR_FIXTURES.openai());
        const bVendor = await scoped("POST", "/vendor/create.json", ROOT_TOKEN, tenantBId, vendorFixtures.VENDOR_FIXTURES.openai());
        const bModel = await scoped("POST", "/model/create.json", ROOT_TOKEN, tenantBId, {
            name: "b-only-model",
            enable: true,
            routing_mode: "single",
            routing_config: { upstreams: [{ vendor_id: bVendor.body.id, enabled: true }] },
        });
        bModelId = bModel.body.id;
    });

    it("开启时：root 在 tenant-b 视角能看到 b-only-model", async () => {
        const res = await scoped("GET", "/model/list.json", ROOT_TOKEN, tenantBId);
        expect(res.status).toBe(200);
        expect(res.body.list.some((m: any) => m.name === "b-only-model")).toBe(true);
    });

    it("关闭后：仅暴露 main，非 main 数据不可见；X-Tenant-ID 指定非 main 报错", async () => {
        await setMultiTenant(false);

        // root 视角（无 header → main）看不到 tenant-b 的模型
        const list = await scoped("GET", "/model/list.json", ROOT_TOKEN);
        expect(list.status).toBe(200);
        expect(list.body.list.some((m: any) => m.name === "b-only-model")).toBe(false);

        // 显式指定非 main 租户 → 400（不静默回退）
        const cross = await scoped("GET", "/model/list.json", ROOT_TOKEN, tenantBId);
        expect(cross.status).toBe(400);

        // 租户管理写操作禁用
        const createTenant = await scoped("POST", "/tenant.json", ROOT_TOKEN, undefined, { name: "tenant-d" });
        expect(createTenant.status).toBe(400);
    });

    it("重新开启后：非 main 数据恢复可见", async () => {
        await setMultiTenant(true);

        const res = await scoped("GET", "/model/list.json", ROOT_TOKEN, tenantBId);
        expect(res.status).toBe(200);
        expect(res.body.list.some((m: any) => m.name === "b-only-model")).toBe(true);
    });

    it("main admin 在关闭/开启下都只见 main 租户数据", async () => {
        // 此时开关开启
        const res = await scoped("GET", "/model/list.json", adminToken);
        expect(res.status).toBe(200);
        expect(res.body.list.some((m: any) => m.name === "b-only-model")).toBe(false);
    });
});
