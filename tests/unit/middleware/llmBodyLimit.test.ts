import { describe, expect, it } from "vitest";
import { resolveBodyLimitViolation } from "../../../src/middleware/llmApiMiddleware";

/**
 * P2-03：LLM 请求体上限的判定纯函数。
 *
 * 抽成纯函数的意义是可单测：上限从硬编码 32MB 改成配置项 `llm_max_body_bytes` 之后，
 * 「0 = 不限」「content-length 缺失（chunked）」「头与实际不一致」这三种边界都只能靠这里钉住。
 * API 层用例（p2-cleanup）只覆盖「真的会 413」，判定细节在这里验。
 */

const LIMIT = 1024;

describe("resolveBodyLimitViolation", () => {
    it("声明长度超过上限：命中快速路径 declared_length", () => {
        expect(resolveBodyLimitViolation(String(LIMIT + 1), 0, LIMIT)).toBe("declared_length");
    });

    it("声明长度等于上限：不算超限（边界是 > 而不是 >=）", () => {
        expect(resolveBodyLimitViolation(String(LIMIT), 0, LIMIT)).toBeNull();
    });

    it("content-length 头缺失（chunked）：按实读长度判 actual_length", () => {
        expect(resolveBodyLimitViolation(undefined, LIMIT + 1, LIMIT)).toBe("actual_length");
    });

    it("content-length 为空串：不把 Number(\"\")=0 当超限，改按实读长度判", () => {
        expect(resolveBodyLimitViolation("", 0, LIMIT)).toBeNull();
        expect(resolveBodyLimitViolation("", LIMIT + 1, LIMIT)).toBe("actual_length");
    });

    it("content-length 非数字（伪造头）：不 NaN 误判，改按实读长度判", () => {
        expect(resolveBodyLimitViolation("not-a-number", 0, LIMIT)).toBeNull();
        expect(resolveBodyLimitViolation("not-a-number", LIMIT + 1, LIMIT)).toBe("actual_length");
    });

    it("头没超但实读超了（头与实际不一致）：兜底判 actual_length", () => {
        expect(resolveBodyLimitViolation("10", LIMIT + 1, LIMIT)).toBe("actual_length");
    });

    it("上限配置为 0 表示不限：任意长度都放行", () => {
        expect(resolveBodyLimitViolation(String(10 * LIMIT), 10 * LIMIT, 0)).toBeNull();
        expect(resolveBodyLimitViolation(undefined, 10 * LIMIT, 0)).toBeNull();
    });

    it("上限为负（脏配置）按不限处理，不会把所有请求打成 413", () => {
        expect(resolveBodyLimitViolation(String(LIMIT), LIMIT, -1)).toBeNull();
    });

    it("正常请求（头与实读都未超）：返回 null", () => {
        expect(resolveBodyLimitViolation("20", 20, LIMIT)).toBeNull();
    });
});
