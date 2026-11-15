import { describe, expect, it } from "vitest";
import customError from "../../../src/customError";

/**
 * P2-19：AppError 识别统一到 `customError.isAppError(e, kind?)`。
 *
 * 原来各处写 `e instanceof customError.AppError` —— 同一份代码被不同路径/不同 realm 加载时
 * 构造函数不是同一个引用（worker 里跨模块打包、测试里跨 fork 都有这个形态），instanceof 直接失效，
 * 于是 4xx 被当成 500 处理（文案泄漏 + 失败率统计错位）。这里把两种识别路径都钉住。
 */

const { AppError, NotFoundError, ClientWriteError, RateLimitError, AccessDeniedError, isAppError } = customError;

/** 模拟「跨 realm / 重复打包」后的形态：原型链断了，但 Symbol.for 标记与 name 被复制过来了 */
function crossRealmClone(err: Error & { statusCode?: number; code?: string }): Error {
    const rebuilt = new Error(err.message);
    rebuilt.name = err.name;
    (rebuilt as any)[Symbol.for("AppError")] = (err as any)[Symbol.for("AppError")];
    (rebuilt as any).statusCode = err.statusCode;
    (rebuilt as any).code = err.code;
    return rebuilt;
}

describe("isAppError", () => {
    it("认得原生 AppError 及 4xx 子类实例", () => {
        expect(isAppError(new AppError("bad request", 400))).toBe(true);
        expect(isAppError(new NotFoundError("missing"))).toBe(true);
        expect(isAppError(new AccessDeniedError("denied"))).toBe(true);
        expect(isAppError(new RateLimitError("slow down", 3))).toBe(true);
    });

    it("ClientWriteError 是内部写流失败信号（继承 Error，不是 4xx），不能被当成 AppError", () => {
        // 若被误判成 AppError，客户端断开会被回写成 4xx，失败码归类也会错
        expect(isAppError(new ClientWriteError(new Error("socket closed")))).toBe(false);
        expect(isAppError(new ClientWriteError("string cause"), "ClientWriteError")).toBe(false);
    });

    it("instanceof 失效（跨 realm）时靠 Symbol.for 标记仍能认出 4xx", () => {
        const original = new AppError("tenant not found", 404, "not_found");
        const cloned = crossRealmClone(original);
        expect(cloned instanceof AppError, "前提：克隆体已不具备 instanceof 关系").toBe(false);
        expect(isAppError(cloned), "跨 realm 也必须认成 AppError").toBe(true);
        expect(isAppError(cloned, "AppError")).toBe(true);
    });

    it("普通错误 / 非对象不会被误判成 AppError", () => {
        expect(isAppError(new Error("boom"))).toBe(false);
        expect(isAppError(new TypeError("boom"))).toBe(false);
        expect(isAppError(null)).toBe(false);
        expect(isAppError(undefined)).toBe(false);
        expect(isAppError("String error")).toBe(false);
        expect(isAppError({ message: "fake" })).toBe(false);
    });

    it("只带 Symbol 标记但没有原型关系的普通对象：按 AppError 处理（避免 4xx 被当 500）", () => {
        const tagged = { message: "x", name: "AppError", [Symbol.for("AppError")]: true };
        expect(isAppError(tagged)).toBe(true);
    });

    it("kind 重载按 name 收窄子类：不能把 NotFoundError 认成 RateLimitError", () => {
        const notFound = new NotFoundError("missing");
        expect(isAppError(notFound, "NotFoundError")).toBe(true);
        expect(isAppError(notFound, "RateLimitError")).toBe(false);
        expect(isAppError(notFound, "AccessDeniedError")).toBe(false);
    });

    it("跨 realm 克隆体的 kind 判定同样有效（子类 name 被保留）", () => {
        const cloned = crossRealmClone(new RateLimitError("slow down", 5));
        expect(isAppError(cloned, "RateLimitError")).toBe(true);
        expect(isAppError(cloned, "AccessDeniedError")).toBe(false);
    });

    it("子类实例保留各自属性，便于调用方直接取 retryAfterSeconds / ruleId", () => {
        const rate = new RateLimitError("slow down", 7);
        const denied = new AccessDeniedError("rule blocked", 42);
        if (isAppError(rate, "RateLimitError")) {
            expect(rate.retryAfterSeconds).toBe(7);
        }
        if (isAppError(denied, "AccessDeniedError")) {
            expect(denied.ruleId).toBe(42);
        }
    });
});
