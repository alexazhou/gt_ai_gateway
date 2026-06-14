import { describe, it, expect } from "vitest";
import { rewriteCchInSystemPrompt } from "../../src/util/cchRewriter";

describe("cchRewriter", () => {
    it("should rewrite cch when system is a string starting with the billing header", () => {
        const body = {
            system: "x-anthropic-billing-header: cc_version=2.1.153.9bb; cc_entrypoint=cli; cch=5a235;\nSome other instructions.",
            messages: []
        };
        const result = JSON.parse(rewriteCchInSystemPrompt(JSON.stringify(body)));
        expect(result.system).toContain("cch=A1234;");
        expect(result.system).not.toContain("cch=5a235;");
    });

    it("should rewrite cch when system is an array and the first element starts with the billing header", () => {
        const body = {
            system: [
                { type: "text", text: "x-anthropic-billing-header: cc_version=2.0; cch=old_value;\nInstruction 1" },
                { type: "text", text: "Instruction 2" }
            ]
        };
        const result = JSON.parse(rewriteCchInSystemPrompt(JSON.stringify(body)));
        expect(result.system[0].text).toContain("cch=A1234;");
        expect(result.system[0].text).not.toContain("cch=old_value;");
    });

    it("should not rewrite if system is a string but does not start with the billing header", () => {
        const body = {
            system: "You are a helpful assistant. x-anthropic-billing-header: cch=123;"
        };
        const originalStr = JSON.stringify(body);
        const result = rewriteCchInSystemPrompt(originalStr);
        expect(result).toBe(originalStr);
    });

    it("should not rewrite if system is an array but the first element does not start with the billing header", () => {
        const body = {
            system: [
                { type: "text", text: "Instruction 1" },
                { type: "text", text: "x-anthropic-billing-header: cch=123;" }
            ]
        };
        const originalStr = JSON.stringify(body);
        const result = rewriteCchInSystemPrompt(originalStr);
        expect(result).toBe(originalStr);
    });

    it("should ignore invalid JSON", () => {
        const invalidJson = "{ invalid }";
        const result = rewriteCchInSystemPrompt(invalidJson);
        expect(result).toBe(invalidJson);
    });

    it("should ignore missing system field", () => {
        const body = { messages: [] };
        const originalStr = JSON.stringify(body);
        const result = rewriteCchInSystemPrompt(originalStr);
        expect(result).toBe(originalStr);
    });

    it("should handle system array when empty", () => {
        const body = { system: [], messages: [] };
        const originalStr = JSON.stringify(body);
        const result = rewriteCchInSystemPrompt(originalStr);
        expect(result).toBe(originalStr);
    });

    it("should handle system array when first block is not text", () => {
        const body = { 
            system: [
                { type: "image", source: {} },
                { type: "text", text: "x-anthropic-billing-header: cch=123;" }
            ], 
            messages: [] 
        };
        const originalStr = JSON.stringify(body);
        const result = rewriteCchInSystemPrompt(originalStr);
        expect(result).toBe(originalStr);
    });
});
