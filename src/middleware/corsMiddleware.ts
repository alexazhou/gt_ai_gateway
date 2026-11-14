import { cors } from "hono/cors";

/**
 * 允许跨域访问的来源判定。
 *
 * 历史两个坑（本文件都收口了）：
 * 1. 修复前用 `origin.startsWith("http://localhost")` 做前缀判断，`http://localhost.evil.example.com`
 *    这类「以白名单前缀开头」的域名会被当成可信源回显（credentials: true）→ P1-12。
 * 2. `origin.startsWith("tauri://")` 同样是 scheme 前缀放行，`tauri://evil.com` 也能过 → 收紧为精确匹配。
 *
 * 现在的口径：**精确比对**（scheme + host，端口不敏感），白名单之外一律拒绝。
 */

/** 桌面端（Tauri 壳）的固定源，精确匹配 */
const TAURI_LOCAL_ORIGIN = "tauri://localhost";

/**
 * 部署兜底：允许用 `EXTRA_ALLOWED_ORIGINS`（逗号分隔）追加可信源，
 * 例如自建前端 `https://admin.example.com`。不设时不影响任何默认行为。
 */
const EXTRA_ALLOWED_ORIGINS_ENV = "EXTRA_ALLOWED_ORIGINS";

/** 归一化：去空白、去尾斜杠、统一小写，避免 `http://LocalHost:1420/` 这类写法漏判 */
function normalizeOrigin(origin: string): string {
    return origin.trim().replace(/\/+$/, "").toLowerCase();
}

function extraAllowedOrigins(): string[] {
    const raw = process.env[EXTRA_ALLOWED_ORIGINS_ENV];
    if (!raw) {
        return [];
    }
    return raw.split(",").map(normalizeOrigin).filter((item) => item.length > 0);
}

function isAllowedOrigin(origin: string): boolean {
    const normalized = normalizeOrigin(origin);
    if (!normalized) {
        return false;
    }

    // Tauri 自定义协议：只认精确的 tauri://localhost（不再按 scheme 前缀放行）
    if (normalized === normalizeOrigin(TAURI_LOCAL_ORIGIN)) {
        return true;
    }

    // 部署方通过 env 追加的可信源，同样按精确串比对
    if (extraAllowedOrigins().includes(normalized)) {
        return true;
    }

    let url: URL;
    try {
        url = new URL(normalized);
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
