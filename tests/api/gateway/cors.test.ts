import { describe, it, expect } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import corsMiddleware from "../../../src/middleware/corsMiddleware";

/**
 * CORS 中间件用例（原覆盖率 0）。
 *
 * 它决定「哪些源能带凭据访问管理端 API」，属于安全面，必须有断言看住。
 *
 * 修复前的实现用 `origin.startsWith("http://localhost")` 做前缀判断，
 * `http://localhost.evil.example.com` / `http://127.0.0.1.evil.com` 这类
 * 「以白名单前缀开头」的域名会被当成可信源原样回显 —— 攻击者只要拥有 evil.example.com
 * 就能开一个 `localhost.evil.example.com` 的子域，配合 credentials:true 拿到
 * 受害者的带回凭据跨站响应。下面 A2 组就是这条的回归看门狗。
 */
const CHAT_ENDPOINT = "/llm/v1/chat/completions";

// A1：真正可信的源（本地前端、Tauri 壳）
const ALLOWED_ORIGINS = [
    "http://localhost:1420",
    "http://127.0.0.1:5173",
    "http://tauri.localhost",
    "tauri://localhost",
    "https://localhost:8443",
];

// A2：必须被拒的源 —— 前三项是「白名单前缀 + 攻击者域名」的前缀绕过回归
const DISALLOWED_ORIGINS = [
    "https://evil.example.com",
    "http://localhost.evil.example.com",
    "http://127.0.0.1.evil.com",
    "http://tauri.localhost.evil.example.com",
    "https://localhost.evil.example.com",
    "http://localhost:1420.evil.example.com",
];

describe("CORS 中间件", () => {
    describe("A1 可信源放行", () => {
        it.each(ALLOWED_ORIGINS)(
            "预检时原样回显 %s 且允许携带凭据",
            async (origin) => {
                const response = await requestHelper.request(CHAT_ENDPOINT, {
                    method: "OPTIONS",
                    headers: {
                        Origin: origin,
                        "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "content-type,authorization",
                    },
                });

                expect(response.headers.get("access-control-allow-origin")).toBe(origin);
                expect(response.headers.get("access-control-allow-credentials")).toBe("true");

                const allowMethods = (response.headers.get("access-control-allow-methods") || "").toUpperCase();
                expect(allowMethods).toContain("POST");

                const allowHeaders = (response.headers.get("access-control-allow-headers") || "").toLowerCase();
                expect(allowHeaders).toContain("content-type");
                expect(allowHeaders).toContain("authorization");
            },
        );
    });

    describe("A2 非白名单源拒绝（含前缀匹配绕过回归）", () => {
        it.each(DISALLOWED_ORIGINS)(
            "%s 不得被回显",
            async (origin) => {
                const response = await requestHelper.request(CHAT_ENDPOINT, {
                    method: "OPTIONS",
                    headers: {
                        Origin: origin,
                        "Access-Control-Request-Method": "POST",
                    },
                });

                const allowOrigin = response.headers.get("access-control-allow-origin");
                // 既不能回显该源，也不能给通配 `*`
                expect(allowOrigin).not.toBe(origin);
                expect(allowOrigin).toBeNull();
            },
        );
    });

    describe("A3 纯函数口径（不经网关注入，直接测判定）", () => {
        it.each(ALLOWED_ORIGINS)("%s 判定为可信", (origin) => {
            expect(corsMiddleware.isAllowedOrigin(origin)).toBe(true);
        });

        it.each(DISALLOWED_ORIGINS)("%s 判定为不可信", (origin) => {
            expect(corsMiddleware.isAllowedOrigin(origin)).toBe(false);
        });

        it.each([
            "",
            "not-a-url",
            "file:///etc/passwd",
            "ftp://localhost",
            "chrome-extension://abcdefghijklmnop",
        ])("异常/非 http(s) 源 %s 一律不可信", (origin) => {
            expect(corsMiddleware.isAllowedOrigin(origin)).toBe(false);
        });
    });

    describe("A5 Tauri scheme 精确匹配 / EXTRA_ALLOWED_ORIGINS 兜底", () => {
        // 修复前 `origin.startsWith("tauri://")` 是 scheme 前缀放行，任意 tauri:// 域名都能过
        it.each([
            "tauri://evil.com",
            "tauri://localhost.evil.example.com",
            "tauri://localhost.evil.com/",
        ])("%s 判定为不可信", (origin) => {
            expect(corsMiddleware.isAllowedOrigin(origin)).toBe(false);
        });

        it("tauri://localhost 仍判定为可信（归一化不误伤）", () => {
            expect(corsMiddleware.isAllowedOrigin("tauri://localhost")).toBe(true);
            expect(corsMiddleware.isAllowedOrigin("  TAURI://LocalHost/  ")).toBe(true);
        });

        it("EXTRA_ALLOWED_ORIGINS 可追加可信源，删除后立即失效", () => {
            const previous = process.env.EXTRA_ALLOWED_ORIGINS;
            try {
                process.env.EXTRA_ALLOWED_ORIGINS = "https://admin.example.com, https://ops.example.com/";
                expect(corsMiddleware.isAllowedOrigin("https://admin.example.com")).toBe(true);
                expect(corsMiddleware.isAllowedOrigin("https://ops.example.com")).toBe(true);
                // 只认精确串，不做前缀/子域放行
                expect(corsMiddleware.isAllowedOrigin("https://admin.example.com.evil.com")).toBe(false);
                expect(corsMiddleware.isAllowedOrigin("https://another.example.com")).toBe(false);
            } finally {
                if (previous === undefined) {
                    delete process.env.EXTRA_ALLOWED_ORIGINS;
                } else {
                    process.env.EXTRA_ALLOWED_ORIGINS = previous;
                }
            }

            // 未设 env 时默认行为不变
            expect(corsMiddleware.isAllowedOrigin("https://admin.example.com")).toBe(false);
        });
    });

    describe("A4 无 Origin", () => {
        it("非浏览器客户端（无 Origin）不回 ACAO 头，也不被中间件拒绝", async () => {
            const response = await requestHelper.request(CHAT_ENDPOINT, {
                method: "OPTIONS",
                headers: {
                    "Access-Control-Request-Method": "POST",
                },
            });

            expect(response.status).toBeLessThan(400);
            // 无 Origin 不属于 CORS 范畴；回 `*` 与 credentials:true 组合在规范上无效
            expect(response.headers.get("access-control-allow-origin")).toBeNull();
        });
    });
});
