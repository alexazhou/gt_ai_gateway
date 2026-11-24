import type { HeaderPatch, JsonPatchOp } from "../types";
import { PatchRejectedError } from "./errors";
import { formatJsonPointer, parseJsonPointer } from "./jsonPointer";
import { PROTECTED_BODY_FIELDS, isProtectedHeader } from "./headers";

/**
 * 声明式补丁的应用器（step2_technical.md §4「安全边界」）。
 *
 * 三条不变量：
 *
 * 1. **只读入参、不就地改写**：请求体在克隆体上落地，调用方传进来的对象一个字节都不动。
 *    这也是「整份拒绝」的实现方式——任何一步校验失败，原请求还是原样，直接继续转发即可。
 * 2. **先全量校验、再落地**：指针语法、受保护字段/头、值是否 JSON 可表示，全部前置检查，
 *    不出现「前两条生效、第三条被拒」的半污染状态。
 * 3. **只报告真实改动**：`applied` 里只放真正改变了值的路径，管线层据此决定是否留痕
 *    （时间线要求「未改写不留空记录」）。
 */

export interface PatchApplyResult<T> {
    readonly value: T;
    /** 实际生效的路径：请求体是 JSON Pointer、请求头是小写头名，供时间线 details.executed 使用 */
    readonly applied: readonly string[];
}

type PlannedOp =
    | { op: "add"; tokens: string[]; value: unknown }
    | { op: "replace"; tokens: string[]; value: unknown }
    | { op: "remove"; tokens: string[] };

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * 深拷贝出一个 JSON 可表示的副本；顺带拒绝不属于 JSON 的值。
 *
 * 插件返回的补丁最终要序列化发给上游，`undefined` / `NaN` / 函数这类值序列化后语义会变
 * （`undefined` 被丢掉、`NaN` 变 `null`），在这里挡掉比让上游收到畸形请求体好。
 */
export function cloneJsonValue(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new PatchRejectedError(`Non-finite number is not JSON-serializable: ${String(value)}`, "invalid_value");
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => cloneJsonValue(item));
    }
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = cloneJsonValue(item);
        }
        return out;
    }
    throw new PatchRejectedError(
        `Value is not JSON-serializable: ${typeof value}`,
        "invalid_value",
    );
}

/** 校验单条操作的「结构合法性」（不依赖当前文档状态）；受保护字段在这里就拒 */
function planBodyOp(rawOp: JsonPatchOp): PlannedOp {
    // 补丁来自插件运行期返回值，按 unknown 视图校验：静态类型挡不住手写的非法结构
    const candidate = rawOp as { op?: unknown; path?: unknown; value?: unknown } | null | undefined;
    if (!candidate || typeof candidate !== "object") {
        throw new PatchRejectedError("Patch operation must be an object with an \"op\" field", "invalid_operation");
    }
    const op = candidate.op;
    if (op !== "add" && op !== "replace" && op !== "remove") {
        throw new PatchRejectedError(`Unsupported patch operation: "${String(op)}"`, "invalid_operation");
    }

    const tokens = parseJsonPointer(candidate.path as string);
    const firstSegment = tokens[0].toLowerCase();
    if (PROTECTED_BODY_FIELDS.has(firstSegment)) {
        throw new PatchRejectedError(
            `Field "${tokens[0]}" is protected and cannot be patched`,
            "protected_field",
            formatJsonPointer(tokens),
        );
    }

    if (op === "remove") {
        return { op: "remove", tokens };
    }
    if (!("value" in candidate)) {
        throw new PatchRejectedError(`Patch operation "${op}" requires a value`, "invalid_operation", formatJsonPointer(tokens));
    }
    // 值在这里就做一次可序列化校验与拷贝，落地时直接用副本
    return { op, tokens, value: cloneJsonValue(candidate.value) };
}

function parseArrayIndex(token: string, length: number, path: string, allowAppend: boolean): number {
    if (token === "-") {
        if (allowAppend) {
            return length;
        }
        throw new PatchRejectedError(`"-" is only valid for add: ${path}`, "invalid_index", path);
    }
    if (!ARRAY_INDEX_PATTERN.test(token)) {
        throw new PatchRejectedError(`Invalid array index "${token}": ${path}`, "invalid_index", path);
    }
    const index = Number(token);
    if (index > length || (!allowAppend && index === length)) {
        throw new PatchRejectedError(`Array index ${index} out of range (length ${length}): ${path}`, "invalid_index", path);
    }
    return index;
}

function readChild(container: unknown, token: string, path: string): unknown {
    if (Array.isArray(container)) {
        const index = parseArrayIndex(token, container.length, path, false);
        return container[index];
    }
    if (container !== null && typeof container === "object") {
        if (!Object.prototype.hasOwnProperty.call(container, token)) {
            throw new PatchRejectedError(`Path not found: ${path}`, "path_not_found", path);
        }
        return (container as Record<string, unknown>)[token];
    }
    throw new PatchRejectedError(
        `Path not found: ${path} (cannot descend into ${container === null ? "null" : typeof container})`,
        "path_not_found",
        path,
    );
}

function resolveParent(root: unknown, tokens: readonly string[], path: string): { container: unknown; key: string } {
    let current: unknown = root;
    for (let i = 0; i < tokens.length - 1; i++) {
        current = readChild(current, tokens[i], path);
    }
    return { container: current, key: tokens[tokens.length - 1] };
}

function applyPlannedOp(root: unknown, plan: PlannedOp): void {
    const path = formatJsonPointer(plan.tokens);
    const { container, key } = resolveParent(root, plan.tokens, path);

    if (Array.isArray(container)) {
        const index = parseArrayIndex(key, container.length, path, plan.op === "add");
        if (plan.op === "remove") {
            container.splice(index, 1);
            return;
        }
        if (plan.op === "add") {
            container.splice(index, 0, plan.value);
            return;
        }
        container[index] = plan.value;
        return;
    }

    if (container === null || typeof container !== "object") {
        throw new PatchRejectedError(
            `Path not found: ${path} (cannot descend into ${container === null ? "null" : typeof container})`,
            "path_not_found",
            path,
        );
    }

    const record = container as Record<string, unknown>;
    const exists = Object.prototype.hasOwnProperty.call(record, key);
    if (plan.op === "remove") {
        if (!exists) {
            throw new PatchRejectedError(`Path not found: ${path}`, "path_not_found", path);
        }
        delete record[key];
        return;
    }
    if (plan.op === "replace" && !exists) {
        throw new PatchRejectedError(`Path not found (replace requires existing target): ${path}`, "path_not_found", path);
    }
    record[key] = plan.value;
}

/**
 * 应用一份请求体补丁。
 *
 * 返回新对象（原 `body` 不变）；任何违规都抛 `PatchRejectedError`，此时调用方应原样转发请求。
 */
export function applyBodyPatch(
    body: Readonly<Record<string, unknown>>,
    ops: readonly JsonPatchOp[],
): PatchApplyResult<Record<string, unknown>> {
    if (!Array.isArray(ops)) {
        throw new PatchRejectedError("bodyPatch must be an array of operations", "invalid_operation");
    }
    if (ops.length === 0) {
        return { value: body as Record<string, unknown>, applied: [] };
    }

    // 阶段一：全量结构校验（受保护字段、指针语法、值可序列化），任一条不过就整份拒绝
    const plans = ops.map((op) => planBodyOp(op));

    // 阶段二：在克隆体上落地（失败时原 body 依然完好）
    const working = cloneJsonValue(body) as Record<string, unknown>;
    for (const plan of plans) {
        applyPlannedOp(working, plan);
    }

    return { value: working, applied: plans.map((plan) => formatJsonPointer(plan.tokens)) };
}

function assertHeaderName(name: unknown): string {
    const raw = typeof name === "string" ? name.trim() : "";
    if (!raw || !HEADER_NAME_PATTERN.test(raw)) {
        throw new PatchRejectedError(`Invalid header name: ${String(name)}`, "invalid_operation");
    }
    if (isProtectedHeader(raw)) {
        throw new PatchRejectedError(`Header "${raw}" is protected and cannot be patched`, "protected_header", raw.toLowerCase());
    }
    return raw;
}

/**
 * 应用一份请求头补丁。
 *
 * 返回新的 `Headers`（原对象不变）；受保护头（鉴权 / 网关管控 / `cf-` / `sec-` 前缀）一律拒绝。
 * `applied` 只包含真正发生变化的头名（同名同值不算改动）。
 */
export function applyHeaderPatch(
    headers: Headers,
    patch: HeaderPatch | undefined,
): PatchApplyResult<Headers> {
    const working = new Headers(headers);
    const applied: string[] = [];

    if (!patch) {
        return { value: working, applied };
    }
    if (typeof patch !== "object" || Array.isArray(patch)) {
        throw new PatchRejectedError("headerPatch must be an object", "invalid_operation");
    }

    const setEntries = Object.entries(patch.set ?? {});
    const removeEntries = patch.remove ?? [];
    if (!Array.isArray(removeEntries)) {
        throw new PatchRejectedError("headerPatch.remove must be an array of header names", "invalid_operation");
    }

    // 阶段一：全量校验（头名合法且不受保护、值无 CR/LF 注入）
    const setPlans: { name: string; value: string }[] = [];
    for (const [rawName, rawValue] of setEntries) {
        const name = assertHeaderName(rawName);
        if (typeof rawValue !== "string") {
            throw new PatchRejectedError(`Header "${name}" value must be a string`, "invalid_value", name.toLowerCase());
        }
        if (rawValue.includes("\r") || rawValue.includes("\n")) {
            throw new PatchRejectedError(`Header "${name}" value must not contain CR/LF`, "invalid_value", name.toLowerCase());
        }
        setPlans.push({ name, value: rawValue });
    }
    const removePlans = removeEntries.map((name) => assertHeaderName(name));

    // 阶段二：落地到副本上，只记录真实变化
    for (const { name, value } of setPlans) {
        const before = working.get(name);
        if (working.has(name) && before === value) {
            continue;
        }
        working.set(name, value);
        applied.push(name.toLowerCase());
    }
    for (const name of removePlans) {
        if (!working.has(name)) {
            continue;
        }
        working.delete(name);
        applied.push(name.toLowerCase());
    }

    return { value: working, applied };
}
