import { PatchRejectedError } from "./errors";

/**
 * RFC 6901 JSON Pointer 的最小子集实现。
 *
 * 只做两件事：把 `/a/b/0` 拆成 token 数组、把 token 数组还原成指针字符串。
 * 容器解析（对象 / 数组、下标越界与否）留给 applyPatch，保持这里纯粹。
 */

/** 从指针字符串解析 token 数组；`""` 与 `"/"` 都表示根对象，一律按「禁止替换根」拒绝 */
export function parseJsonPointer(pointer: string): string[] {
    if (typeof pointer !== "string") {
        throw new PatchRejectedError("Patch path must be a string", "invalid_pointer");
    }
    if (pointer === "" || pointer === "/") {
        throw new PatchRejectedError(
            `Replacing the root object is not allowed: "${pointer}"`,
            "root_replacement",
            pointer,
        );
    }
    if (!pointer.startsWith("/")) {
        throw new PatchRejectedError(`Invalid JSON pointer: "${pointer}"`, "invalid_pointer", pointer);
    }
    // 转义顺序必须 ~1 先于 ~0（RFC 6901 §4），否则 "~01" 会被错误还原成 "/"
    return pointer
        .slice(1)
        .split("/")
        .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** token 数组 → 指针字符串（转义顺序与解析相反：先 ~ 后 /） */
export function formatJsonPointer(tokens: readonly string[]): string {
    return `/${tokens.map((t) => t.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
