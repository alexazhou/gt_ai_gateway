/**
 * 请求体键名清洗（P2-26）。
 *
 * 背景：`JSON.parse` 会把 `"__proto__"` / `"constructor"` / `"prototype"` 解析成**自有属性**，
 * 随后 `new SgModel(body)` / `new SgVendor(body)` 走 Sutando 的 `fill()`，casts 查表命中
 * 原型链上的键（`casts["constructor"]` 拿到 Object 构造函数而不是 cast 定义），
 * 直接抛 `TypeError: castType is not a constructor` / `castType.toLocaleLowerCase is not a function`
 * → 客户端一个畸形 body 就能把接口打成 500（不是 4xx，也不会被当成参数错误）。
 *
 * 处理：在「请求体 → 模型」这一步把这三个键剔掉。它们本来就不是业务字段，
 * 剔除比报错更好（客户端多传个 `constructor` 不该让整个创建/更新失败）。
 */

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);


/**
 * 返回一份只含自有可枚举属性、且剔除原型链危险键的浅拷贝。
 * 非对象输入原样返回（由调用方决定如何校验）。
 */
export function stripUnsafeKeys<T>(input: T): T {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return input;
    }

    const source = input as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
        if (UNSAFE_KEYS.has(key)) {
            continue;
        }
        clean[key] = source[key];
    }
    return clean as T;
}


export default {
    stripUnsafeKeys,
};
