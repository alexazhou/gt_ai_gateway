import ormService from "./service/ormService";
import app from "./routes";
import { RunMode } from "./constants";

// 初始化云端配置
await ormService.init({ mode: RunMode.WORKER });

// Worker mode SPA fallback - serve index.html via ASSETS binding for non-API routes
app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // API 路由不该被 SPA fallback 兜住，直接 404 而不是回 index.html。
    // - `/llm/`：LLM 入口（`/llm/v1/chat/completions` 等）
    // - `/v1/`：历史别名，客户端/文档里仍有人直连 `/v1/...`；P2-16 曾把它当「死代码」想删，
    //   实际 `tests/api/frontend/frontendApi.test.ts` 就断言 `/v1/nonexistent` 必须返回 JSON 404 —— 不是死代码，保留
    // - `*.json`：管理端接口统一后缀
    if (pathname.startsWith("/llm/") || pathname.startsWith("/v1/") || pathname.endsWith(".json")) {
        return c.notFound();
    }

    // Serve from Assets binding
    if (c.env.ASSETS) {
        try {
            const response = await c.env.ASSETS.fetch(new Request("https://example.com/index.html"));
            if (response.ok) {
                const html = await response.text();
                return c.html(html, 200);
            }
        } catch (e) {
            // Fall through to 404
        }
    }

    return c.notFound();
});

export default app;
