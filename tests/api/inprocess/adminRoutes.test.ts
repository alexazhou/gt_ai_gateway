import { beforeAll, describe, expect, it } from "vitest";
import app from "../../../src/routes";
import ormService from "../../../src/service/ormService";
import { RunMode } from "../../../src/constants";
import config from "../../config";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";

/**
 * 进程内 API 冒烟（覆盖率用）。
 *
 * 为什么需要这个文件：`tests/globalSetup.ts` 用 `spawn("npx tsx src/local.ts")` 起独立进程，
 * V8 只能统计测试进程内的代码 —— 所以 routes / controllers / middleware 在这些 API 用例里
 * 进程内计数长期是 **0%**（覆盖率低的真实原因，不是「入口文件没覆盖」）。
 *
 * 这里直接用 `app.request()` 在测试进程内驱动同一套 Hono 路由：同一条 request 会真实流过
 * CORS → dbMiddleware → 鉴权中间件 → controller → service，等于把主干链路的代码都纳进统计，
 * 同时还能断言 401/200 的口径。
 *
 * 注意：只做「只读主链路」，写链路（create/update）由各业务用例覆盖，避免这里造数据过多。
 */

const ADMIN_TOKEN = "admin-token-for-test";
const ROOT_TOKEN = "root-token-123";

let adminToken: string;

function request(path: string, init?: RequestInit) {
    // root 身份由 env.ROOT_TOKEN 判定（与真服务一致），这里把测试用 root token 注入进去
    return app.request(`http://localhost${path}`, init, { ROOT_TOKEN } as any);
}

function getWithToken(path: string, token = ADMIN_TOKEN) {
    return request(path, { headers: { Authorization: `Bearer ${token}` } });
}

describe("进程内 API 冒烟（routes → middleware → controller → service）", () => {
    beforeAll(async () => {
        // 真服务（src/local.ts）启动时会 init 一次；进程内测试要自己补，否则请求里所有查询都 500
        await ormService.init({ mode: RunMode.NODE, dbPath: config.DB_CONFIG.path });
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
    }, 60000);

    it("/welcome 无需鉴权即可访问", async () => {
        const res = await request("/welcome");
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("serverless ai gateway");
    });

    it("无凭证访问管理端接口：401（走 authenticateAdmin 失败分支）", async () => {
        const res = await request("/status.json");
        expect(res.status).toBe(401);
    });

    it("一组只读管理端接口在进程内都能正常返回 200", async () => {
        const paths = [
            "/status.json",
            "/config.json",
            "/vendor/list.json",
            "/vendor/preset-urls.json",
            "/model/list.json",
            "/user/list.json",
            "/rule/list.json",
            "/balance/recharge/list.json",
            "/record/list.json?page=1&pageSize=10",
            "/record/latest.json?limit=5",
            "/stats/dashboard.json",
            "/stats/recent.json",
            "/client-config/status.json",
        ];

        for (const path of paths) {
            const res = await getWithToken(path);
            expect(res.status, `${path} 期望 200，实际 ${res.status}`).toBe(200);
        }

        // 租户列表只对 root 开放（assertRoot），单独用 root 凭证走一遍
        const tenants = await getWithToken("/tenant.json", ROOT_TOKEN);
        expect(tenants.status, "/tenant.json（root）期望 200").toBe(200);
    });

    it("未知 API 路径 404，且响应是 JSON（不被 SPA fallback 兜住）", async () => {
        const res = await getWithToken("/nope/unknown.json");
        expect(res.status).toBe(404);
        expect(typeof await res.json()).toBe("object");
    });

    it("CORS 预检：白名单 Origin 预检直接 204/200 放行", async () => {
        const res = await request("/model/list.json", {
            method: "OPTIONS",
            headers: {
                Origin: "http://localhost:1420",
                "Access-Control-Request-Method": "GET",
            },
        });
        expect([200, 204]).toContain(res.status);
        expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
    });

    it("LLM 入口无凭证：走 llmApiMiddleware 的 401 分支（不是管理端鉴权文案）", async () => {
        const res = await request("/llm/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "whatever", messages: [] }),
        });
        expect(res.status).toBe(401);
    });

    it("按 id 取详情：不存在的资源返回 404（而非 500）", async () => {
        for (const path of ["/model/999999", "/vendor/999999", "/user/999999", "/rule/999999"]) {
            const res = await getWithToken(path);
            expect([404, 400], `${path} 实际 ${res.status}`).toContain(res.status);
        }
    });

    it("管理端 token 失效：401 且不落到 controller", async () => {
        const res = await getWithToken("/model/list.json", "not-a-real-token");
        expect(res.status).toBe(401);
        expect(adminToken).toBeTruthy();
    });
});
