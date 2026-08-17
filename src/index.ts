import ormService from "./service/ormService";
import app from "./routes";
import { RunMode } from "./constants";

// 初始化云端配置
await ormService.init({ mode: RunMode.WORKER });

// Worker mode SPA fallback - serve index.html via ASSETS binding for non-API routes
app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // API routes should return 404
    if (pathname.startsWith("/v1/") || pathname.startsWith("/llm/") || pathname.includes(".json")) {
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
