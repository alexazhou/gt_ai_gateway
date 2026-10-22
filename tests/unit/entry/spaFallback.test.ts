import { describe, expect, it, vi } from "vitest";

// index.ts 在模块顶层会 await ormService.init({mode: WORKER}) 连 D1 —— 单测不需要真连接
vi.mock("../../../src/service/ormService", () => ({
    default: { init: async () => undefined },
}));

// 用最小路由替代真实业务路由：本用例只关心「fallback 有没有兜住 API 路径」
vi.mock("../../../src/routes", async () => {
    const { Hono } = await import("hono");
    const minimal = new Hono();
    minimal.get("/api/ping", c => c.json({ ok: true }));
    return { default: minimal };
});

const { default: app } = await import("../../../src/index");

/**
 * P2-16：Worker 模式 SPA fallback 的边界。
 *
 * index.ts 里挂了 `app.get("*")`：
 * - 非 API 路径 → 用 ASSETS binding 回 index.html（前端 SPA 路由刷新不白屏）
 * - API 路径（`/llm/`、`/v1/` 历史别名、`*.json`）→ 必须 404，不能回 index.html
 *   （否则前端拿到一坨 HTML 去 JSON.parse，错误信息完全对不上）
 *
 * 这里用 `app.request(path, init, env)` 在同一进程里直接驱动 Hono：
 * 既能精确控制 ASSETS binding（正常 / 缺失 / 抛错三种），又不用起 worker 环境。
 * ormService.init 被 mock 掉（应用启动时会连 D1，单测不需要）。
 */

const SPA_HTML = "<html><body><div id=\"app\">SPA-INDEX</div></body></html>";

function envWithAssets(overrides: Partial<{ ok: boolean; throws: boolean }> = {}) {
    return {
        ASSETS: {
            fetch: async () => {
                if (overrides.throws) {
                    throw new Error("ASSETS binding broken");
                }
                return new Response(SPA_HTML, {
                    status: overrides.ok === false ? 404 : 200,
                    headers: { "content-type": "text/html; charset=utf-8" },
                });
            },
        },
    } as any;
}

describe("P2-16 SPA fallback 路由边界", () => {
    it("前端路由（非 API 路径）回 index.html，状态 200", async () => {
        const res = await app.request("/dashboard/models", {}, envWithAssets());

        expect(res.status).toBe(200);
        expect(await res.text()).toContain("SPA-INDEX");
        expect(res.headers.get("content-type") ?? "").toContain("text/html");
    });

    it("`/llm/` 前缀不回 SPA：未知 LLM 路径必须 404", async () => {
        const res = await app.request("/llm/v1/unknown-endpoint", {}, envWithAssets());

        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("SPA-INDEX");
    });

    it("`/v1/` 历史别名同样 404（不是死代码，老客户端仍在用）", async () => {
        const res = await app.request("/v1/nonexistent", {}, envWithAssets());

        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("SPA-INDEX");
    });

    it("`*.json` 管理端接口不回 SPA：未知接口 404", async () => {
        const res = await app.request("/some/unknown.json", {}, envWithAssets());

        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("SPA-INDEX");
    });

    it("没有 ASSETS binding（比如纯 API 部署）：退回 404，不伪造页面", async () => {
        const res = await app.request("/dashboard", {}, {} as any);

        expect(res.status).toBe(404);
    });

    it("ASSETS.fetch 抛错：兜底 404，不把异常冒成 500", async () => {
        const res = await app.request("/dashboard", {}, envWithAssets({ throws: true }));

        expect(res.status).toBe(404);
    });

    it("ASSETS 返回非 ok（比如 404）：同样兜底 404", async () => {
        const res = await app.request("/dashboard", {}, envWithAssets({ ok: false }));

        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("SPA-INDEX");
    });

    it("已注册的 API 路由不受 fallback 影响（正常响应 JSON）", async () => {
        const res = await app.request("/api/ping", {}, envWithAssets());

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });
});
