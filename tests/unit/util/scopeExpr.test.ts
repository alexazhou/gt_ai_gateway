import { describe, expect, it } from "vitest";
import scopeExpr from "../../../src/util/rule/scopeExpr";
import type { ExprNode, RequestContext } from "../../../src/util/rule/types";

const ctx: RequestContext = { user_id: 3, model_id: 5, vendor_id: 9 };

describe("scopeExpr", () => {
    describe("matchCondition", () => {
        it("matches all four operators against a scalar actual value", () => {
            expect(scopeExpr.matchCondition(5, { type: "model_id", oper: "=", values: [5] })).toBe(true);
            expect(scopeExpr.matchCondition(6, { type: "model_id", oper: "=", values: [5] })).toBe(false);
            expect(scopeExpr.matchCondition(6, { type: "model_id", oper: "!=", values: [5] })).toBe(true);
            expect(scopeExpr.matchCondition(5, { type: "model_id", oper: "!=", values: [5] })).toBe(false);
            expect(scopeExpr.matchCondition(3, { type: "user_id", oper: "in", values: [3, 4, 5] })).toBe(true);
            expect(scopeExpr.matchCondition(9, { type: "user_id", oper: "in", values: [3, 4, 5] })).toBe(false);
            expect(scopeExpr.matchCondition(10, { type: "user_id", oper: "not in", values: [3, 4, 5] })).toBe(true);
            expect(scopeExpr.matchCondition(4, { type: "user_id", oper: "not in", values: [3, 4, 5] })).toBe(false);
        });

        it("is dimension-agnostic (works the same for vendor_id)", () => {
            expect(scopeExpr.matchCondition(9, { type: "vendor_id", oper: "=", values: [9] })).toBe(true);
            expect(scopeExpr.matchCondition(8, { type: "vendor_id", oper: "=", values: [9] })).toBe(false);
        });
    });

    describe("evalExpr", () => {
        it("matches leaf operators = / != / in / not in", () => {
            expect(scopeExpr.evalExpr({ type: "model_id", oper: "=", values: [5] }, ctx)).toBe(true);
            expect(scopeExpr.evalExpr({ type: "model_id", oper: "=", values: [6] }, ctx)).toBe(false);
            expect(scopeExpr.evalExpr({ type: "model_id", oper: "!=", values: [6] }, ctx)).toBe(true);
            expect(scopeExpr.evalExpr({ type: "model_id", oper: "!=", values: [5] }, ctx)).toBe(false);
            expect(scopeExpr.evalExpr({ type: "user_id", oper: "in", values: [3, 4, 5] }, ctx)).toBe(true);
            expect(scopeExpr.evalExpr({ type: "user_id", oper: "in", values: [10] }, ctx)).toBe(false);
            expect(scopeExpr.evalExpr({ type: "user_id", oper: "not in", values: [10, 11] }, ctx)).toBe(true);
            expect(scopeExpr.evalExpr({ type: "user_id", oper: "not in", values: [3, 4] }, ctx)).toBe(false);
        });

        it("vendor_id matches against ctx.vendor_id", () => {
            expect(scopeExpr.evalExpr({ type: "vendor_id", oper: "=", values: [9] }, ctx)).toBe(true);
            expect(scopeExpr.evalExpr({ type: "vendor_id", oper: "=", values: [8] }, ctx)).toBe(false);
            // vendor_id 缺失（阶段一路由前）时与任何值都不等
            expect(scopeExpr.evalExpr({ type: "vendor_id", oper: "=", values: [9] }, { user_id: 1, model_id: 2 })).toBe(false);
        });

        it("const node is always true", () => {
            expect(scopeExpr.evalExpr({ type: "const", values: [true] }, ctx)).toBe(true);
        });

        it("AND requires all children true", () => {
            const and: ExprNode = { type: "and", values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "user_id", oper: "=", values: [3] },
            ]};
            expect(scopeExpr.evalExpr(and, ctx)).toBe(true);
            const mismatch: ExprNode = { type: "and", values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "user_id", oper: "=", values: [4] },
            ]};
            expect(scopeExpr.evalExpr(mismatch, ctx)).toBe(false);
        });

        it("OR requires any child true", () => {
            const or: ExprNode = { type: "or", values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "model_id", oper: "=", values: [6] },
            ]};
            expect(scopeExpr.evalExpr(or, ctx)).toBe(true);
            const none: ExprNode = { type: "or", values: [
                { type: "model_id", oper: "=", values: [6] },
                { type: "model_id", oper: "=", values: [7] },
            ]};
            expect(scopeExpr.evalExpr(none, ctx)).toBe(false);
        });

        it("supports arbitrary nesting", () => {
            const nested: ExprNode = { type: "and", values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "or", values: [
                    { type: "user_id", oper: "in", values: [3, 4, 5] },
                    { type: "vendor_id", oper: "=", values: [9] },
                ]},
            ]};
            expect(scopeExpr.evalExpr(nested, ctx)).toBe(true);
        });
    });

    describe("exprReferencesVendor", () => {
        it("returns false for non-vendor leaves and const", () => {
            expect(scopeExpr.exprReferencesVendor({ type: "model_id", oper: "=", values: [5] })).toBe(false);
            expect(scopeExpr.exprReferencesVendor({ type: "user_id", oper: "=", values: [1] })).toBe(false);
            expect(scopeExpr.exprReferencesVendor({ type: "const", values: [true] })).toBe(false);
        });

        it("returns true for vendor leaf", () => {
            expect(scopeExpr.exprReferencesVendor({ type: "vendor_id", oper: "=", values: [9] })).toBe(true);
        });

        it("recurses into and/or", () => {
            const withVendor: ExprNode = { type: "and", values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "or", values: [{ type: "vendor_id", oper: "=", values: [9] }] },
            ]};
            expect(scopeExpr.exprReferencesVendor(withVendor)).toBe(true);

            const withoutVendor: ExprNode = { type: "and", values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "user_id", oper: "=", values: [3] },
            ]};
            expect(scopeExpr.exprReferencesVendor(withoutVendor)).toBe(false);
        });
    });

    describe("validateScope", () => {
        it("accepts valid trees", () => {
            expect(() => scopeExpr.validateScope({ type: "const", values: [true] })).not.toThrow();
            expect(() => scopeExpr.validateScope({ type: "and", values: [{ type: "model_id", oper: "=", values: [5] }] })).not.toThrow();
            expect(() => scopeExpr.validateScope({
                type: "or",
                values: [
                    { type: "model_id", oper: "in", values: [5, 6] },
                    { type: "user_id", oper: "not in", values: [1] },
                ],
            })).not.toThrow();
        });

        it("rejects empty and/or values", () => {
            expect(() => scopeExpr.validateScope({ type: "and", values: [] })).toThrow(/non-empty/);
            expect(() => scopeExpr.validateScope({ type: "or", values: [] })).toThrow(/non-empty/);
        });

        it("rejects invalid operators", () => {
            expect(() => scopeExpr.validateScope({ type: "model_id", oper: "==", values: [5] })).toThrow(/operator/);
        });

        it("rejects = / != without exactly one value", () => {
            expect(() => scopeExpr.validateScope({ type: "model_id", oper: "=", values: [5, 6] })).toThrow(/exactly one/);
            expect(() => scopeExpr.validateScope({ type: "model_id", oper: "!=", values: [] })).toThrow(/exactly one/);
        });

        it("rejects empty values for in / not in", () => {
            expect(() => scopeExpr.validateScope({ type: "user_id", oper: "in", values: [] })).toThrow(/non-empty/);
            expect(() => scopeExpr.validateScope({ type: "user_id", oper: "not in", values: [] })).toThrow(/non-empty/);
        });

        it("rejects const with non-[true] values", () => {
            expect(() => scopeExpr.validateScope({ type: "const", values: [] })).toThrow(/\[true\]/);
            expect(() => scopeExpr.validateScope({ type: "const", values: [false] })).toThrow(/\[true\]/);
        });

        it("rejects non-integer values", () => {
            expect(() => scopeExpr.validateScope({ type: "model_id", oper: "=", values: [1.5] })).toThrow(/integers/);
            expect(() => scopeExpr.validateScope({ type: "model_id", oper: "=", values: ["5"] as any })).toThrow(/integers/);
        });

        it("rejects non-object scope (null / array / primitive)", () => {
            expect(() => scopeExpr.validateScope(null)).toThrow(/object/);
            expect(() => scopeExpr.validateScope([])).toThrow(/object/);
            expect(() => scopeExpr.validateScope("model_id")).toThrow(/object/);
        });

        it("rejects leaf values that are not an array", () => {
            expect(() => scopeExpr.validateScope({ type: "model_id", oper: "=", values: 5 as any })).toThrow(/array/);
            expect(() => scopeExpr.validateScope({ type: "user_id", oper: "in", values: "1,2" as any })).toThrow(/array/);
        });

        it("rejects unknown node type", () => {
            expect(() => scopeExpr.validateScope({ type: "foo", values: [] })).toThrow(/node type/);
        });

        it("rejects trees deeper than the depth limit", () => {
            let node: any = { type: "model_id", oper: "=", values: [5] };
            for (let i = 0; i < 12; i++) {
                node = { type: "and", values: [node] };
            }
            expect(() => scopeExpr.validateScope(node)).toThrow(/depth/i);
        });
    });
});
