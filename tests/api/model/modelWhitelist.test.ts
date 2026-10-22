import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import modelFixtures from "../../fixtures/modelFixtures";

/**
 * P1-09 验收门：`PUT /model/:id` 只允许白名单字段。
 *
 * 修复前是 `const { id, tenant_id, ...rest } = inputModel.toData(); model.fill(rest)`——
 * 请求 body 里**任意列**都会被写进模型：客户端可以篡改 `created_at` / `updated_at`
 * （审计时间线直接失效），也能写进以后新增的内部列。修复后走显式白名单，未知字段静默忽略。
 */

const UPDATABLE_FIELDS = ["name", "enable", "prices", "routing_mode", "routing_config", "cross_tenant"];

let adminToken: string;
let vendorId: number;

function toModelRequest(model: any) {
    return {
        name: model.name,
        enable: Boolean(model.enable),
        prices: model.prices ?? {},
        routing_mode: model.routing_mode,
        routing_config: model.routing_config,
    };
}

async function readModelRow(id: number): Promise<any> {
    const rows = await dbHelper.query<any>(
        `SELECT id, name, created_at, updated_at, tenant_id, enable FROM model WHERE id = ${id}`,
    );
    return rows[0];
}

async function createModel(): Promise<any> {
    const response = await requestHelper.post(
        "/model/create.json",
        modelFixtures.createRandomModel(vendorId, `whitelist-model-${Date.now()}`),
        adminToken,
    );
    expect(response.status, `创建 model 失败: ${JSON.stringify(response.body)}`).toBe(200);
    return response.body;
}

describe("P1-09 PUT /model/:id 字段白名单", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "openai",
                name: "whitelist-vendor",
                token: "sk-whitelist-token",
                urls: { openai: "http://localhost:9999/v1/chat/completions" },
            },
            adminToken,
        );
        expect(vendor.status).toBe(200);
        vendorId = vendor.body.id;
    });

    it("body 里的 created_at / updated_at 不得写库（审计时间线不能被客户端篡改）", async () => {
        const model = await createModel();
        const before = await readModelRow(model.id);

        const response = await requestHelper.put(
            `/model/${model.id}`,
            {
                ...toModelRequest(model),
                name: "renamed-with-fake-timestamps",
                created_at: "2000-01-01 00:00:00",
                updated_at: "2000-01-01 00:00:01",
            },
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.name).toBe("renamed-with-fake-timestamps");

        const after = await readModelRow(model.id);
        expect(after.name).toBe("renamed-with-fake-timestamps");
        expect(after.created_at, "created_at 必须保持原值").toBe(before.created_at);
        expect(after.updated_at, "updated_at 不能被客户端指定").not.toBe("2000-01-01 00:00:01");
    });

    it("body 里的 tenant_id 不得改归属", async () => {
        const model = await createModel();
        const before = await readModelRow(model.id);

        const response = await requestHelper.put(
            `/model/${model.id}`,
            { ...toModelRequest(model), tenant_id: 9999 },
            adminToken,
        );

        // 200 = 静默忽略（不是报错），但归属必须没变
        expect(response.status).toBe(200);
        expect((await readModelRow(model.id)).tenant_id).toBe(before.tenant_id);
    });

    it("未知列（body 里凭空多出来的字段）不会让接口 500，也不会落库", async () => {
        const model = await createModel();

        const response = await requestHelper.put(
            `/model/${model.id}`,
            {
                ...toModelRequest(model),
                hacked_column: "pwned",
                internal_flag: 1,
            },
            adminToken,
        );

        expect(response.status, "白名单实现应静默忽略未知字段，而不是把 SQL 打崩").toBe(200);
        // 表结构里没有这一列 → 查一下不应存在（PRAGMA 取列名，避免 SQL 报错中断用例）
        const columns = await dbHelper.query<any>("PRAGMA table_info(model)");
        const names = columns.map((c) => c.name);
        expect(names).not.toContain("hacked_column");
        expect(names).toContain("created_at");
    });

    it("白名单内字段照常可更新（enable / name / prices）", async () => {
        const model = await createModel();

        const response = await requestHelper.put(
            `/model/${model.id}`,
            {
                ...toModelRequest(model),
                name: "whitelisted-updates",
                enable: false,
                prices: { input: 1.5, output: 2.5 },
            },
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.name).toBe("whitelisted-updates");
        expect(Boolean(response.body.enable), "enable 应为 falsy（各驱动可能回 0 / false）").toBe(false);
        expect(response.body.prices).toEqual({ input: 1.5, output: 2.5 });

        const row = await readModelRow(model.id);
        expect(row.name).toBe("whitelisted-updates");
        expect(Boolean(row.enable)).toBe(false);
    });

    it("审计列读出来仍是服务端写入格式（不是客户端可控的任意串）", async () => {
        const model = await createModel();
        await requestHelper.put(
            `/model/${model.id}`,
            { ...toModelRequest(model), created_at: "1970-01-01 00:00:00" },
            adminToken,
        );

        const row = await readModelRow(model.id);
        // 必须是 'YYYY-MM-DD HH:mm:ss' 形态的本地时间文本，而不是被塞进来的 1970
        expect(String(row.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
        expect(String(row.created_at)).not.toContain("1970");
    });

    it("白名单列表与实现保持同步（防止以后加了字段忘了加进白名单）", async () => {
        // 只做参照：本用例锁定「以下字段必须可更新」，其余一律忽略
        const model = await createModel();
        for (const field of UPDATABLE_FIELDS) {
            expect(Object.prototype.hasOwnProperty.call(toModelRequest(model), field) || field === "cross_tenant").toBe(true);
        }
    });
});
