import { describe, expect, it } from "vitest";
import abortTimeoutUtil from "../../../src/util/abortTimeoutUtil";
import { FailedCode } from "../../../src/constants";


const { TaggedError, isTaggedError, classifyUpstreamFetchError, describeError } = abortTimeoutUtil;


/** 模拟 workerd 跨 fetch 边界重建后的形态：原型丢失、name 与自定义属性被复制过来 */
function workerdWrapped(tagged: Error & { failedCode: FailedCode }): Error {
    const rebuilt = new Error(tagged.message);
    rebuilt.name = tagged.name;
    (rebuilt as any).failedCode = tagged.failedCode;
    return rebuilt;
}


describe("isTaggedError", () => {
    it("认原生的 TaggedError 实例", () => {
        expect(isTaggedError(new TaggedError(FailedCode.UPSTREAM_TIMEOUT, "超时"))).toBe(true);
    });

    it("认 workerd 重建后的形态（原型已丢，只靠 name + failedCode）", () => {
        const wrapped = workerdWrapped(new TaggedError(FailedCode.UPSTREAM_TIMEOUT, "超时"));

        expect(wrapped instanceof TaggedError).toBe(false);
        expect(isTaggedError(wrapped)).toBe(true);
        expect(describeError(wrapped)).toBe("超时");
    });

    it("不认普通 Error（含 workerd 的网络错误）", () => {
        expect(isTaggedError(new Error("Network connection lost."))).toBe(false);
        expect(isTaggedError(new TypeError("fetch failed"))).toBe(false);
    });

    it("不认 name 对但没有 failedCode 的错误", () => {
        const fake = new Error("上游响应超时");
        fake.name = "TaggedError";
        expect(isTaggedError(fake)).toBe(false);
    });

    it("不认非 Error 值（避免把上游返回的任意对象误判）", () => {
        expect(isTaggedError(null)).toBe(false);
        expect(isTaggedError(undefined)).toBe(false);
        expect(isTaggedError("TaggedError")).toBe(false);
        expect(isTaggedError({ name: "TaggedError", failedCode: FailedCode.UPSTREAM_TIMEOUT })).toBe(false);
    });
});


describe("TaggedError", () => {
    it("name 固定为 TaggedError，failedCode 与 cause 挂在实例上", () => {
        const cause = new Error("底层原因");
        const e = new TaggedError(FailedCode.UPSTREAM_DISCONNECTED, "上游断开", cause);

        expect(e.name).toBe("TaggedError");
        expect(e.failedCode).toBe(FailedCode.UPSTREAM_DISCONNECTED);
        expect(e.message).toBe("上游断开");
        expect(e.cause).toBe(cause);
        expect(e instanceof Error).toBe(true);
    });
});


describe("classifyUpstreamFetchError", () => {
    it("透传我们自己的 abort（超时 / 客户端断开），归因不被覆盖", () => {
        const timeout = new TaggedError(FailedCode.UPSTREAM_TIMEOUT, "上游响应超时");
        expect(classifyUpstreamFetchError(timeout)).toBe(timeout);

        const wrapped = workerdWrapped(new TaggedError(FailedCode.CLIENT_DISCONNECTED, "客户端断开连接"));
        const classified = classifyUpstreamFetchError(wrapped);
        expect(classified.failedCode).toBe(FailedCode.CLIENT_DISCONNECTED);
    });

    it("undici 网络失败（TypeError: fetch failed）→ UPSTREAM_UNREACHABLE", () => {
        const e = new TypeError("fetch failed");
        (e as any).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });

        const classified = classifyUpstreamFetchError(e);
        expect(classified.failedCode).toBe(FailedCode.UPSTREAM_UNREACHABLE);
        // 文案取原始错误，不按失败码生成——errno 得留在里面才排得了查
        expect(classified.message).toContain("fetch failed");
        expect(classified.message).toContain("ECONNREFUSED");
        expect(classified.cause).toBe(e);
    });

    it("workerd 网络失败（Error: Network connection lost.）→ UPSTREAM_UNREACHABLE", () => {
        const classified = classifyUpstreamFetchError(new Error("Network connection lost."));
        expect(classified.failedCode).toBe(FailedCode.UPSTREAM_UNREACHABLE);
        // workerd 不给 errno / cause，只能拿到这句原文；不额外编造文案
        expect(classified.message).toBe("Error: Network connection lost.");
    });

    it("非网络错误不冒充上游不可达，如实归 UNKNOWN", () => {
        const classified = classifyUpstreamFetchError(new Error("Cannot find module 'undici'"));
        expect(classified.failedCode).toBe(FailedCode.UNKNOWN);
        expect(classified.message).toContain("Cannot find module");
        expect(classified.cause).toBeInstanceOf(Error);
    });

    it("代理地址配错（new URL 抛的 TypeError）归 UNKNOWN，不冒充上游不可达", () => {
        let invalidUrlError: unknown;
        try {
            new URL("not a url");
        } catch (e) {
            invalidUrlError = e;
        }

        // 是 TypeError，但请求压根没发出去，属于配置错误
        expect(invalidUrlError).toBeInstanceOf(TypeError);
        expect(classifyUpstreamFetchError(invalidUrlError).failedCode).toBe(FailedCode.UNKNOWN);
    });

    it("其它 TypeError（代码 bug）同样归 UNKNOWN", () => {
        expect(classifyUpstreamFetchError(new TypeError("Cannot read properties of null (reading 'x')")).failedCode)
            .toBe(FailedCode.UNKNOWN);
    });

    it("非 Error 值也归 UNKNOWN（不误判成网络失败）", () => {
        expect(classifyUpstreamFetchError("boom").failedCode).toBe(FailedCode.UNKNOWN);
        expect(classifyUpstreamFetchError(undefined).failedCode).toBe(FailedCode.UNKNOWN);
    });

    it("归类不改动文案：describeError 结果就是原始错误文本", () => {
        const e = new TypeError("fetch failed");
        (e as any).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });

        const classified = classifyUpstreamFetchError(e);
        expect(classified.message).toBe(describeError(e));
    });
});


describe("describeError", () => {
    it("TaggedError 只取可读文案", () => {
        expect(describeError(new TaggedError(FailedCode.UPSTREAM_TIMEOUT, "上游响应超时"))).toBe("上游响应超时");
    });

    it("普通 Error 拼 name + message", () => {
        expect(describeError(new Error("Network connection lost."))).toBe("Error: Network connection lost.");
    });

    it("有 cause 时拼上 cause", () => {
        const e = new TypeError("fetch failed");
        (e as any).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
        expect(describeError(e)).toBe("TypeError: fetch failed; cause: Error: connect ECONNREFUSED 127.0.0.1:1");
    });

    it("非 Error 值直接 String", () => {
        expect(describeError("boom")).toBe("boom");
    });
});
