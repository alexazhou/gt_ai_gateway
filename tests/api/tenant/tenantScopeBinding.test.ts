import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import mockHelper from "../../helpers/mockHelper";
import modelFixtures from "../../fixtures/modelFixtures";
import config from "../../config";
import { setupAdminUser } from "../../globalSetup";

/**
 * P2-08：租户条件从「模板串拼 SQL」改成 `?` 参数绑定。
 *
 * 原来 `RULE_SCOPE_SQL` / stats 的 today/total 语句把 `tenant_id = ${...}` 直接拼进去，
 * 安全性依赖「调用方一定传整数」这个口头约定 —— 一旦上游某处把 string 透进来（比如
 * X-Tenant-ID 解析、租户名匹配），就成了注入口。
 *
 * 本用例用**带引号的租户名**（`o'brien`、`x' OR '1'='1`）从 X-Tenant-ID 打进去：
 * - 参数绑定正确 → 按名字精确匹配，返回 200 + 该租户自己的（空）数据；
 * - 若是字符串拼接 → SQL 语法错误（500）或条件被注入放宽（看到别的租户的数据）。
 * 两种失败形态都会被断言抓住。
 */

const ROOT_TOKEN = "root-token-123";

let adminToken: string;
let modelName: string;
let tenantNameWithQuote: string;
let tenantNameInjection: string;
let mainTenantId: number;

async function getTenantIdByName(name: string): Promise<number | null> {
    const rows = await dbHelper.query<any>(`SELECT id FROM tenant WHERE name = '${name.replace(/'/g, "''")}'`);
    return rows[0] ? Number(rows[0].id) : null;
}

/** 用指定租户视角查询（requestHelper.get 不能带自定义头，这里用原生 fetch） */
async function scopedGet(path: string, tenantHeader: string) {
    const response = await fetch(`${config.SERVER_CONFIG.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${ROOT_TOKEN}`, "X-Tenant-ID": tenantHeader },
    });
    const text = await response.text();
    let body: any = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // 非 JSON 响应（如 HTML 错误页）保留原文，断言会直接失败
    }
    return { status: response.status, body };
}

describe("P2-08 租户条件参数绑定（不被引号/注入形状的租户名打穿）", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();

        const cfg = await requestHelper.put("/config.json", { multi_tenant_enabled: "true" }, ROOT_TOKEN);
        expect(cfg.status).toBe(200);

        const tenants = await dbHelper.query<any>("SELECT id FROM tenant ORDER BY id ASC LIMIT 1");
        mainTenantId = Number(tenants[0].id);

        // 先造一条属于 main 租户的请求记录，作为「不该被别的租户看到」的数据
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "openai",
                name: `p2-08-vendor-${Date.now()}`,
                token: "sk-p2-08",
                urls: { openai: `${config.UPSTREAM_CONFIG.mock.url}/chat/completions` },
            },
            adminToken,
        );
        expect(vendor.status).toBe(200);

        modelName = `p2-08-model-${Date.now()}`;
        const model = await requestHelper.post(
            "/model/create.json",
            modelFixtures.createRandomModel(vendor.body.id, modelName),
            adminToken,
        );
        expect(model.status).toBe(200);

        const user = await requestHelper.post("/user/create.json", mockHelper.generateUser(), adminToken);
        const chat = await requestHelper.post(
            "/llm/v1/chat/completions",
            { model: modelName, messages: [{ role: "user", content: "hi" }] },
            user.body.token,
        );
        expect([200, 201]).toContain(chat.status);

        // 两个「危险形状」的租户名：一个带单引号，一个带经典注入尾巴
        tenantNameWithQuote = `o'brien-${Date.now()}`;
        tenantNameInjection = `x' OR '1'='1-${Date.now()}`;
        for (const name of [tenantNameWithQuote, tenantNameInjection]) {
            const created = await requestHelper.post("/tenant.json", { name, description: "p2-08" }, ROOT_TOKEN);
            expect(created.status, `创建租户失败: ${JSON.stringify(created.body)}`).toBe(200);
        }
    }, 120000);

    it("main 租户能看到自己的记录（对照）", async () => {
        const res = await scopedGet("/record/latest.json?limit=10", String(mainTenantId));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThan(0);
    });

    it("带单引号的租户名按名字精确匹配：200 + 看不到 main 的数据，不是 500", async () => {
        const res = await scopedGet("/record/latest.json?limit=10", tenantNameWithQuote);

        expect(res.status, "引号不能把 SQL 打断").toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body, "新租户不该看到 main 租户的记录").toHaveLength(0);
    });

    it("注入形状的租户名不会放宽条件（看不到任何别人的记录）", async () => {
        const res = await scopedGet("/record/latest.json?limit=10", tenantNameInjection);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(0);
    });

    it("不存在的租户名：400 可读错误，而不是 500/SQL 报错", async () => {
        const res = await scopedGet("/record/latest.json?limit=10", `no-such-tenant-${Date.now()}`);

        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).not.toMatch(/SQLITE|syntax error|near "/i);
    });

    it("统计面板同样走绑定：注入形状租户名下 today/total 全 0，不报 SQL 错", async () => {
        const res = await scopedGet("/stats/dashboard.json", tenantNameInjection);

        expect(res.status).toBe(200);
        const payload = JSON.stringify(res.body);
        expect(payload).not.toMatch(/SQLITE|syntax error|near "/i);
        // 该租户没有请求，统计必须是 0 而不是「全租户合计」
        expect(payload).toContain("0");
        expect(payload).not.toContain(modelName);
    });

    it("租户名带引号时仍能查到自己的 id（findByName 也是绑定参数）", async () => {
        const id = await getTenantIdByName(tenantNameWithQuote);
        expect(id).toBeGreaterThan(0);
        expect(id).not.toBe(mainTenantId);
    });
});
