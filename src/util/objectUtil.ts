/**
 * 判断值是否为非数组的普通对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default {
    isRecord,
};
