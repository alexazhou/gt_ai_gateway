import ormService from "./service/ormService";
import app from "./routes";
import { RunMode } from "./constants";

// 初始化云端配置
await ormService.init({ mode: RunMode.WORKER });

// Worker mode SPA fallback - serve index.html via ASSETS binding for non-API routes
app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // API 路由不该被 SPA fallback 兜住，直接 404。
    // 真实 API 面只有两类：`/llm/*`（LLM 入口）与 `*.json`（管理端接口）。
    // 原实现判 `/v1/` 是死代码 —— 实际路径是 `/llm/v1/chat/completions`，永远命中不到，会把它误当静态资源。
    if (pathname.startsWith("/llm/") || pathname.endsWith(".json")) {
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
