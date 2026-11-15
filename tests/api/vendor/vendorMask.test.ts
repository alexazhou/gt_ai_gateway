import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import maskUtil from "../../../src/util/maskUtil";

/**
 * P1-08 验收门：管理端凭据脱敏。
 *
 * 修复前 `/vendor/list.json`、`/vendor/:id` 直接把 `vendor.token` 和 `config.proxy.url`
 * 原样回传：一次普通的列表查询就能拿到全部上游明文 key（含代理账号密码）。
 * 修复后所有 vendor 出口统一走 `formatVendor`：token 走 `maskToken`（只留前 4 位），
 * proxy url 的 userinfo 走 `maskUrlCredentials`（`user:pass@` → `****@`）。
 *
 * 同时钉住编辑语义：前端拿到的是掩码，用户「不改只保存」时掩码会被原样回传，
 * 这种情况必须**不改库内真值**，否则一次改名字的保存就能把 token 打成星号。
 */

const REAL_TOKEN = "sk-live-9f3a7c2e1b4d6f8a0c5e"; // >4 位，掩码应保留前 4 位
const SHORT_TOKEN = "abc"; // ≤4 位，掩码应全星号
const PROXY_URL = "http://proxyuser:proxypass@127.0.0.1:8888";

let adminToken: string;

async function readVendorRow(id: number): Promise<any> {
    const rows = await dbHelper.query<any>(`SELECT id, token, config FROM vendor WHERE id = ${id}`);
    return rows[0];
}

async function createVendor(overrides: Record<string, unknown> = {}): Promise<any> {
    const response = await requestHelper.post(
        "/vendor/create.json",
        {
            type: "openai",
            name: `mask-vendor-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            token: REAL_TOKEN,
            urls: { openai: "http://localhost:9999/v1/chat/completions" },
            ...overrides,
        },
        adminToken,
    );
    expect(response.status, `创建 vendor 失败: ${JSON.stringify(response.body)}`).toBe(200);
    return response.body;
}

/** 只改名字（模拟「用户没碰 token，直接点保存」） */
function renameOnlyBody(name: string): Record<string, unknown> {
    return { type: "openai", name, urls: { openai: "http://localhost:9999/v1/chat/completions" } };
}

describe("P1-08 管理端凭据脱敏", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
    });

    beforeEach(async () => {
        await dbHelper.execute("DELETE FROM vendor");
    });

    it("列表接口不返回明文 token，只回前 4 位 + 掩码", async () => {
        const created = await createVendor();
        const response = await requestHelper.get("/vendor/list.json", adminToken);

        expect(response.status).toBe(200);
        const list: any[] = Array.isArray(response.body) ? response.body : response.body?.list ?? [];
        const mine = list.find((v) => v.id === created.id);
        expect(mine, "列表里应能找到刚建的 vendor").toBeTruthy();

        expect(mine.token).toBe(maskUtil.maskToken(REAL_TOKEN));
        expect(mine.token).not.toBe(REAL_TOKEN);
        expect(mine.token.startsWith("sk-l")).toBe(true);
        // 整个响应体都不能出现明文（防止别的字段把 token 带出去）
        expect(JSON.stringify(response.body)).not.toContain(REAL_TOKEN);
    });

    it("详情接口同样脱敏，且代理 URL 的账号密码被抹掉", async () => {
        const created = await createVendor({ config: { proxy: { type: "http", url: PROXY_URL } } });

        const response = await requestHelper.get(`/vendor/${created.id}`, adminToken);
        expect(response.status).toBe(200);

        expect(response.body.token).toBe(maskUtil.maskToken(REAL_TOKEN));
        expect(response.body.config?.proxy?.url).toBe("http://****@127.0.0.1:8888");

        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain(REAL_TOKEN);
        expect(serialized).not.toContain("proxypass");
        expect(serialized).not.toContain("proxyuser");
    });

    it("短 token（≤4 位）全星号，且不因长度泄露字符数以外信息", async () => {
        const created = await createVendor({ token: SHORT_TOKEN });
        const response = await requestHelper.get(`/vendor/${created.id}`, adminToken);

        expect(response.body.token).toBe("***");
        expect(response.body.token).toHaveLength(SHORT_TOKEN.length);
    });

    it("只改名字（token 留空）时库内真 token 不变", async () => {
        const created = await createVendor();

        const response = await requestHelper.put(
            `/vendor/${created.id}`,
            renameOnlyBody("renamed-without-token"),
            adminToken,
        );

        expect(response.status).toBe(200);
        expect(response.body.name).toBe("renamed-without-token");
        expect((await readVendorRow(created.id)).token, "库里必须还是真 token").toBe(REAL_TOKEN);
        // 但响应依旧是掩码
        expect(response.body.token).toBe(maskUtil.maskToken(REAL_TOKEN));
    });

    it("token 传空串 / 纯空白 / 原样回传掩码，都视为「不修改」", async () => {
        const created = await createVendor();
        const masked = maskUtil.maskToken(REAL_TOKEN);

        for (const tokenInput of ["", "   ", masked]) {
            const response = await requestHelper.put(
                `/vendor/${created.id}`,
                { ...renameOnlyBody("still-masked"), token: tokenInput },
                adminToken,
            );
            expect(response.status, `token=${JSON.stringify(tokenInput)} 时更新应成功`).toBe(200);
            expect(
                (await readVendorRow(created.id)).token,
                `token=${JSON.stringify(tokenInput)} 不应覆盖库内真值`,
            ).toBe(REAL_TOKEN);
        }
    });

    it("传真实新 token 时才更新库内值", async () => {
        const created = await createVendor();
        const newToken = "sk-rotated-1111222233334444";

        const response = await requestHelper.put(
            `/vendor/${created.id}`,
            { ...renameOnlyBody("rotated"), token: newToken },
            adminToken,
        );

        expect(response.status).toBe(200);
        expect((await readVendorRow(created.id)).token).toBe(newToken);
        expect(response.body.token).toBe(maskUtil.maskToken(newToken));
    });

    it("代理 URL 掩码原样回存时，库内仍保留真实账号密码", async () => {
        const created = await createVendor({ config: { proxy: { type: "http", url: PROXY_URL } } });

        const detail = await requestHelper.get(`/vendor/${created.id}`, adminToken);
        const maskedUrl = detail.body.config.proxy.url;
        expect(maskedUrl).toBe("http://****@127.0.0.1:8888");

        // 前端「看一眼再保存」：把掩码原样提交回来
        const response = await requestHelper.put(
            `/vendor/${created.id}`,
            {
                ...renameOnlyBody("saved-with-masked-proxy"),
                config: { proxy: { type: "http", url: maskedUrl } },
            },
            adminToken,
        );
        expect(response.status).toBe(200);

        const row = await readVendorRow(created.id);
        const storedConfig = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
        expect(storedConfig.proxy.url, "掩码回存必须还原成真实代理地址").toBe(PROXY_URL);
    });

    it("显式改成新的真实代理地址时按新值保存", async () => {
        const created = await createVendor({ config: { proxy: { type: "http", url: PROXY_URL } } });
        const newUrl = "http://newuser:newpass@10.0.0.9:3128";

        const response = await requestHelper.put(
            `/vendor/${created.id}`,
            { ...renameOnlyBody("proxy-changed"), config: { proxy: { type: "http", url: newUrl } } },
            adminToken,
        );
        expect(response.status).toBe(200);

        const row = await readVendorRow(created.id);
        const storedConfig = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
        expect(storedConfig.proxy.url).toBe(newUrl);
        // 回传仍然是掩码
        expect(response.body.config?.proxy?.url).toBe("http://****@10.0.0.9:3128");
    });
});
