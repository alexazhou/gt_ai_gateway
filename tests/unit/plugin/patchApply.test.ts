import { describe, expect, it } from "vitest";
import { applyBodyPatch, applyHeaderPatch, cloneJsonValue } from "../../../src/plugin/patch/applyPatch";
import { PatchRejectedError } from "../../../src/plugin/patch/errors";
import { PROTECTED_HEADERS, isProtectedHeader } from "../../../src/plugin/patch/headers";

type Body = Record<string, unknown>;

function baseBody(): Body {
    return {
        model: "vendor-model-x",
        stream: true,
        system: [
            { type: "text", text: "x-anthropic-billing-header: cch=old;" },
            { type: "text", text: "instruction" },
        ],
        messages: [{ role: "user", content: "hi" }],
        metadata: { a: 1 },
        "a/b": { nested: true },
        "a~b": 1,
    };
}

/** 捕获被拒时的错误码，避免测试里写成 try/catch 一片 */
function rejectionOf(fn: () => unknown): PatchRejectedError {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(PatchRejectedError);
        return e as PatchRejectedError;
    }
    throw new Error("expected the patch to be rejected, but it was applied");
}

describe("applyBodyPatch", () => {
    it("replace 命中已存在的嵌套路径，原 body 不被改写", () => {
        const body = baseBody();
        const snapshot = JSON.parse(JSON.stringify(body));

        const result = applyBodyPatch(body, [
            { op: "replace", path: "/system/0/text", value: "x-anthropic-billing-header: cch=A1234;" },
        ]);

        expect((result.value.system as any)[0].text).toBe("x-anthropic-billing-header: cch=A1234;");
        expect(result.applied).toEqual(["/system/0/text"]);
        // 只读入参：调用方手里的对象一个字节都没变
        expect(body).toEqual(snapshot);
    });

    it("add 可新增对象键，中间段缺失则整份拒绝（不自动造中间结构）", () => {
        const added = applyBodyPatch(baseBody(), [
            { op: "add", path: "/metadata/b", value: 2 },
        ]);
        expect(added.value.metadata).toEqual({ a: 1, b: 2 });
        expect(added.applied).toEqual(["/metadata/b"]);

        // /tags 原本不存在：中间段缺失 → 拒绝，绝不隐式创建父容器
        const missingParent = rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "add", path: "/tags/0", value: "first" },
        ]));
        expect(missingParent.code).toBe("path_not_found");
    });

    it("数组 insert / append / remove 的下标语义", () => {
        const body: Body = { items: ["a", "c"] };
        const inserted = applyBodyPatch(body, [{ op: "add", path: "/items/1", value: "b" }]);
        expect(inserted.value.items).toEqual(["a", "b", "c"]);

        const appended = applyBodyPatch(body, [{ op: "add", path: "/items/-", value: "z" }]);
        expect(appended.value.items).toEqual(["a", "c", "z"]);

        const removed = applyBodyPatch(body, [{ op: "remove", path: "/items/0" }]);
        expect(removed.value.items).toEqual(["c"]);

        expect(rejectionOf(() => applyBodyPatch(body, [
            { op: "replace", path: "/items/-", value: "x" },
        ])).code).toBe("invalid_index");
        expect(rejectionOf(() => applyBodyPatch(body, [
            { op: "add", path: "/items/9", value: "x" },
        ])).code).toBe("invalid_index");
        expect(rejectionOf(() => applyBodyPatch(body, [
            { op: "remove", path: "/items/01", value: undefined } as any,
        ])).code).toBe("invalid_index");
    });

    it("JSON Pointer 转义按 RFC 6901 还原（~1 → /，~0 → ~）", () => {
        const result = applyBodyPatch(baseBody(), [
            { op: "replace", path: "/a~1b/nested", value: false },
            { op: "replace", path: "/a~0b", value: 2 },
        ]);

        expect((result.value["a/b"] as any).nested).toBe(false);
        expect(result.value["a~b"]).toBe(2);
        // 报告路径时重新转义回指针形式
        expect(result.applied).toEqual(["/a~1b/nested", "/a~0b"]);
    });

    it("禁止替换根对象：\"\" 与 \"/\" 都按 root_replacement 拒绝", () => {
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "replace", path: "", value: { model: "x" } },
        ])).code).toBe("root_replacement");
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "add", path: "/", value: 1 },
        ])).code).toBe("root_replacement");
    });

    it("受保护字段按路径首段拦截：model / stream / stream_options 一律拒绝", () => {
        for (const path of ["/model", "/stream", "/stream_options/include_usage", "/Stream"]) {
            expect(rejectionOf(() => applyBodyPatch(baseBody(), [
                { op: "replace", path, value: "y" },
            ])).code).toBe("protected_field");
        }
        // 首段以外出现同名字段不受限（只有顶层是计费/路由字段）
        const nested = applyBodyPatch(baseBody(), [
            { op: "add", path: "/metadata/model", value: "not-billing" },
        ]);
        expect((nested.value.metadata as any).model).toBe("not-billing");
    });

    it("整份补丁原子拒绝：一条违规则前面的操作一条都不生效", () => {
        const body = baseBody();
        const snapshot = JSON.parse(JSON.stringify(body));

        const error = rejectionOf(() => applyBodyPatch(body, [
            { op: "replace", path: "/messages/0/content", value: "rewritten" },
            { op: "replace", path: "/model", value: "hijacked" },
        ]));

        expect(error.code).toBe("protected_field");
        expect(body).toEqual(snapshot);
    });

    it("指针语法非法、路径不存在、值不可 JSON 化都按各自错误码拒绝", () => {
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "replace", path: "system/0/text", value: "x" },
        ])).code).toBe("invalid_pointer");
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "replace", path: "/system/9/text", value: "x" },
        ])).code).toBe("invalid_index");
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "remove", path: "/metadata/missing" },
        ])).code).toBe("path_not_found");
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "add", path: "/metadata/c", value: undefined },
        ])).code).toBe("invalid_value");
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "add", path: "/metadata/c", value: Number.NaN },
        ])).code).toBe("invalid_value");
        expect(rejectionOf(() => applyBodyPatch(baseBody(), [
            { op: "copy", path: "/metadata/a", from: "/metadata/b" } as any,
        ])).code).toBe("invalid_operation");
    });

    it("空补丁直接返回原 body（applyRequestPlugins 据此判断「未改写」）", () => {
        const body = baseBody();
        const result = applyBodyPatch(body, []);
        expect(result.value).toBe(body);
        expect(result.applied).toEqual([]);
    });

    it("cloneJsonValue 深拷贝且拒绝非 JSON 值", () => {
        const source = { a: [1, { b: 2 }] };
        const clone = cloneJsonValue(source) as typeof source;
        expect(clone).toEqual(source);
        expect(clone.a[1]).not.toBe(source.a[1]);
        expect(() => cloneJsonValue(() => undefined)).toThrow(PatchRejectedError);
        expect(() => cloneJsonValue(Number.POSITIVE_INFINITY)).toThrow(PatchRejectedError);
    });
});

function baseHeaders(): Headers {
    return new Headers({
        "content-type": "application/json",
        "x-client-trace": "abc",
        "x-anthropic-beta": "1",
    });
}

describe("applyHeaderPatch", () => {
    it("set 新增 / 覆盖，applied 只记真实变化的头名", () => {
        const headers = baseHeaders();
        const result = applyHeaderPatch(headers, {
            set: {
                "X-Request-Source": "gateway",
                "x-client-trace": "abc", // 同名同值 → 不算改动
                "x-anthropic-beta": "2", // 同名不同值 → 改动
            },
        });

        expect(result.value.get("x-request-source")).toBe("gateway");
        expect(result.value.get("x-anthropic-beta")).toBe("2");
        expect(result.applied).toEqual(["x-request-source", "x-anthropic-beta"]);
        // 原 Headers 不被改写
        expect(headers.get("x-request-source")).toBeNull();
    });

    it("remove 只删存在的头，不存在的头不算改动", () => {
        const result = applyHeaderPatch(baseHeaders(), {
            remove: ["x-client-trace", "x-not-present"],
        });

        expect(result.value.has("x-client-trace")).toBe(false);
        expect(result.applied).toEqual(["x-client-trace"]);
    });

    it("受保护头一律拒绝：鉴权头、网关管控头、cf-/sec- 前缀", () => {
        for (const name of ["authorization", "X-Api-Key", "cookie", "content-type", "anthropic-version", "cf-ray", "sec-fetch-mode"]) {
            expect(PROTECTED_HEADERS.has(name.toLowerCase()) || isProtectedHeader(name)).toBe(true);
            const error = rejectionOf(() => applyHeaderPatch(baseHeaders(), { set: { [name]: "x" } }));
            expect(error.code).toBe("protected_header");
            expect(rejectionOf(() => applyHeaderPatch(baseHeaders(), { remove: [name] })).code).toBe("protected_header");
        }
    });

    it("非法头名与 CR/LF 注入被拒，且整份不生效", () => {
        expect(rejectionOf(() => applyHeaderPatch(baseHeaders(), {
            set: { "bad header": "x" },
        })).code).toBe("invalid_operation");
        expect(rejectionOf(() => applyHeaderPatch(baseHeaders(), {
            set: { "x-inject": "a\r\nX-Evil: 1" },
        })).code).toBe("invalid_value");

        // 前一条合法、后一条违规 → 合法那条也不落地
        const headers = baseHeaders();
        const error = rejectionOf(() => applyHeaderPatch(headers, {
            set: { "x-legit": "1", authorization: "Bearer evil" },
        }));
        expect(error.code).toBe("protected_header");
        expect(headers.has("x-legit")).toBe(false);
    });

    it("空补丁返回等价副本，applied 为空", () => {
        const headers = baseHeaders();
        const result = applyHeaderPatch(headers, undefined);
        expect(result.applied).toEqual([]);
        expect(result.value.get("x-anthropic-beta")).toBe("1");
        expect(result.value).not.toBe(headers);
    });
});
