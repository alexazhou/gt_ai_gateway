import { describe, it, expect } from "vitest";
import { SgVendor } from "../../src/model/sgVendor";
import { ApiFormat, VendorType } from "../../src/constants";

/**
 * SgVendor URL resolution and merge tests
 *
 * Covers the logic that merges custom (DB-stored) URLs with preset defaults:
 *   custom URL wins → preset used as fallback → path suffix auto-appended
 */

function makeVendor(type: VendorType, urls: Record<string, string> = {}): SgVendor {
    const v = new SgVendor();
    v.type = type;
    v.token = "test-token";
    v.urls = JSON.stringify(urls);
    return v;
}

describe("SgVendor.getUrlByFormat — URL merge & resolution", () => {
    describe("custom URL takes priority over preset", () => {
        it("uses custom openai URL even when preset exists", () => {
            const v = makeVendor("aliyun", {
                openai: "https://custom.example.com/v1",
            });

            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toContain("custom.example.com");
            expect(url).not.toContain("aliyuncs.com");
        });

        it("uses custom anthropic URL even when preset exists", () => {
            const v = makeVendor("deepseek", {
                anthropic: "https://custom.example.com/anthropic",
            });

            const url = v.getUrlByFormat(ApiFormat.ANTHROPIC);
            expect(url).toContain("custom.example.com");
            expect(url).not.toContain("deepseek.com");
        });
    });

    describe("preset URL used when no custom URL provided", () => {
        it("returns aliyun preset openai URL", () => {
            const v = makeVendor("aliyun");
            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toContain("aliyuncs.com");
            expect(url).toContain("chat/completions");
        });

        it("returns aliyun preset anthropic URL", () => {
            const v = makeVendor("aliyun");
            const url = v.getUrlByFormat(ApiFormat.ANTHROPIC);
            expect(url).toContain("aliyuncs.com");
            expect(url).toContain("/v1/messages");
        });

        it("returns deepseek preset openai URL", () => {
            const v = makeVendor("deepseek");
            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toContain("deepseek.com");
            expect(url).toContain("chat/completions");
        });

        it("returns deepseek preset anthropic URL", () => {
            const v = makeVendor("deepseek");
            const url = v.getUrlByFormat(ApiFormat.ANTHROPIC);
            expect(url).toContain("deepseek.com");
            expect(url).toContain("/v1/messages");
        });

        it("returns openai preset URL", () => {
            const v = makeVendor("openai");
            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toContain("api.openai.com");
            expect(url).toContain("chat/completions");
        });

        it("returns anthropic vendor preset anthropic URL", () => {
            const v = makeVendor("anthropic");
            const url = v.getUrlByFormat(ApiFormat.ANTHROPIC);
            expect(url).toContain("api.anthropic.com");
            expect(url).toContain("/v1/messages");
        });

        it("returns google vendor preset openai URL", () => {
            const v = makeVendor("google");
            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toContain("generativelanguage.googleapis.com");
            expect(url).toContain("chat/completions");
        });

        it("returns opencode_go preset openai URL", () => {
            const v = makeVendor("opencode_go");
            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toContain("opencode.ai");
            expect(url).toContain("chat/completions");
        });
    });

    describe("path suffix auto-append", () => {
        it("appends /chat/completions to openai URL that lacks it", () => {
            const v = makeVendor("other", {
                openai: "https://my-api.com/v1",
            });

            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toBe("https://my-api.com/v1/chat/completions");
        });

        it("does not double-append /chat/completions", () => {
            const v = makeVendor("other", {
                openai: "https://my-api.com/v1/chat/completions",
            });

            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toBe("https://my-api.com/v1/chat/completions");
            expect(url.match(/chat\/completions/g)).toHaveLength(1);
        });

        it("appends /v1/messages to anthropic URL that lacks it", () => {
            const v = makeVendor("other", {
                anthropic: "https://my-api.com",
            });

            const url = v.getUrlByFormat(ApiFormat.ANTHROPIC);
            expect(url).toBe("https://my-api.com/v1/messages");
        });

        it("does not double-append /v1/messages", () => {
            const v = makeVendor("other", {
                anthropic: "https://my-api.com/v1/messages",
            });

            const url = v.getUrlByFormat(ApiFormat.ANTHROPIC);
            expect(url).toBe("https://my-api.com/v1/messages");
            expect(url.match(/v1\/messages/g)).toHaveLength(1);
        });

        it("strips trailing slash before appending path", () => {
            const v = makeVendor("other", {
                openai: "https://my-api.com/v1/",
            });

            const url = v.getUrlByFormat(ApiFormat.OPENAI);
            expect(url).toBe("https://my-api.com/v1/chat/completions");
        });
    });

    describe("responses format fallback", () => {
        it("falls back to custom openai base URL for responses format", () => {
            const v = makeVendor("other", {
                openai: "https://my-api.com/v1/chat/completions",
            });

            const url = v.getUrlByFormat(ApiFormat.RESPONSES);
            expect(url).toContain("my-api.com");
            expect(url).toContain("/responses");
        });

        it("falls back to preset openai URL for responses format", () => {
            const v = makeVendor("openai");
            const url = v.getUrlByFormat(ApiFormat.RESPONSES);
            expect(url).toContain("api.openai.com");
            expect(url).toContain("/responses");
        });
    });

    describe("error cases", () => {
        it("throws when vendor type has no preset and no custom URL", () => {
            const v = makeVendor("other");  // no custom URL, no preset

            expect(() => v.getUrlByFormat(ApiFormat.OPENAI)).toThrow(
                "vendor does not have url for openai format",
            );
        });

        it("throws when requesting anthropic format for vendor with only openai URL", () => {
            const v = makeVendor("other", {
                openai: "https://my-api.com/v1/chat/completions",
            });

            expect(() => v.getUrlByFormat(ApiFormat.ANTHROPIC)).toThrow(
                "vendor does not have url for anthropic format",
            );
        });

        it("throws for google vendor requesting anthropic format", () => {
            const v = makeVendor("google");  // google only has openai preset

            expect(() => v.getUrlByFormat(ApiFormat.ANTHROPIC)).toThrow(
                "vendor does not have url for anthropic format",
            );
        });
    });

    describe("getUrls", () => {
        it("parses stored JSON urls correctly", () => {
            const v = makeVendor("other", {
                openai: "https://a.com",
                anthropic: "https://b.com",
            });

            expect(v.getUrls()).toEqual({
                openai: "https://a.com",
                anthropic: "https://b.com",
            });
        });

        it("returns empty object when urls is empty string", () => {
            const v = new SgVendor();
            v.type = "other";
            v.token = "t";
            v.urls = "";

            expect(v.getUrls()).toEqual({});
        });

        it("returns empty object when urls is invalid JSON", () => {
            const v = new SgVendor();
            v.type = "other";
            v.token = "t";
            v.urls = "not-json";

            expect(v.getUrls()).toEqual({});
        });
    });
});
