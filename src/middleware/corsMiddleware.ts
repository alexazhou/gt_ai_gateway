import { cors } from "hono/cors";

/**
 * 允许跨域访问的来源判定。
 *
 * 必须按 URL 解析后精确比对 hostname：修复前用 `origin.startsWith("http://localhost")`
 * 做前缀判断，`http://localhost.evil.example.com`、`http://127.0.0.1.evil.com` 这类
 * "以白名单前缀开头"的域名会被当成可信源回显，等于给任意站点开了带凭据的跨站访问。
 */
function isAllowedOrigin(origin: string): boolean {
    // Tauri 自定义协议（tauri://localhost 或打包后的自定义 scheme）按 scheme 放行
    if (origin.startsWith("tauri://")) {
        return true;
    }

    let url: URL;
    try {
        url = new URL(origin);
    } catch (e) {
        return false;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
    }

    // 桌面端与本地开发：只认这几个 hostname（含端口变化），不做前缀匹配
    return url.hostname === "localhost"
        || url.hostname === "127.0.0.1"
        || url.hostname === "tauri.localhost";
}

const allowCors = cors({
    origin: (origin) => {
        // 无 Origin 的请求不属于 CORS 范畴（服务端到服务端 / curl）：
        // 不回 ACAO 头（回 `*` 与 credentials: true 组合在规范上无效）
        if (!origin) return null;
        return isAllowedOrigin(origin) ? origin : null;
    },
    allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
});

export default { allowCors, isAllowedOrigin };
