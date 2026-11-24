/**
 * 请求头补丁的受保护边界（step2_technical.md §4「安全边界」）。
 *
 * 三类一律拒绝插件改写：
 *
 * 1. **鉴权头**：鉴权头由网关在插件之后写入（双重保障），插件改它等于绕过供应商凭据管控，
 *    轻则 401，重则把 A 供应商的 key 发给 B 供应商；
 * 2. **网关管控头**：客户端带来的这些头被网关剥离、由网关按自身逻辑重新写回
 *    （`content-length` / `host` / `content-type` / `anthropic-version` 等），插件若「复活」它们
 *    会与网关的最终写入打架，实际效果取决于写入顺序——这是不可依赖的行为，直接禁掉；
 * 3. **平台元数据头**：`cf-` / `sec-` 前缀由边缘平台注入，同样不允许插件碰。
 *
 * 注意：`senderService` 构造上游请求头时的排除清单**直接用本文件的 `GATEWAY_STRIPPED_HEADERS`**，
 * 不再各写一份（两份清单必然漂移：插件挡住某个头、上游却把客户端那份透传过去）。
 */

/** 鉴权头：任何情况下插件都不得设置或删除 */
export const PROTECTED_AUTH_HEADERS: readonly string[] = [
    "authorization",
    "x-api-key",
    "proxy-authorization",
    "proxy-authenticate",
    "cookie",
];

/** 网关管控头：网关自己剥离 / 自己写入，插件不得介入 */
export const GATEWAY_MANAGED_HEADERS: readonly string[] = [
    "anthropic-version",
    "content-length",
    "content-type",
    "host",
    "origin",
    "referer",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "accept",
    "accept-encoding",
    "accept-language",
    "priority",
    "user-agent",
];

/** 平台注入前缀：小写匹配 */
export const PROTECTED_HEADER_PREFIXES: readonly string[] = ["cf-", "sec-"];

/** 受保护头集合（全小写，便于大小写无关比较） */
export const PROTECTED_HEADERS: ReadonlySet<string> = new Set([
    ...PROTECTED_AUTH_HEADERS,
    ...GATEWAY_MANAGED_HEADERS,
]);

/**
 * 网关构造上游请求头时要**剥掉**的客户端头集合（大小写无关）。
 *
 * 与上面两张表同源：鉴权头由网关重写、管控头由网关重写，客户端带来的都不该透传。
 * `senderService` 直接用它，避免"插件保护清单"与"上游头过滤清单"各写一份而漂移。
 */
export const GATEWAY_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
    ...PROTECTED_AUTH_HEADERS,
    ...GATEWAY_MANAGED_HEADERS,
]);

/** 头名是否受保护（大小写无关；`cf-` / `sec-` 前缀同样视为受保护） */
export function isProtectedHeader(name: string): boolean {
    const lower = String(name ?? "").trim().toLowerCase();
    if (!lower) {
        return false;
    }
    if (PROTECTED_HEADERS.has(lower)) {
        return true;
    }
    return PROTECTED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * 请求体受保护字段（按路径**首段**匹配）：计费与路由的核心字段。
 *
 * 插件改写 `model` 会让计费按 A 模型算、实际调 B 模型；改写 `stream` / `stream_options`
 * 会让响应解析与用量统计错位。这些都是「事后无法补救」的字段，必须前置拒绝。
 */
export const PROTECTED_BODY_FIELDS: ReadonlySet<string> = new Set([
    "model",
    "stream",
    "stream_options",
]);
