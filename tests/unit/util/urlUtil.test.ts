import { describe, it, expect } from "vitest";
import urlUtil from "../../../src/util/urlUtil";

describe("urlUtil.convertOpenaiToResponses", () => {
    it("converts a standard /chat/completions URL to /responses", () => {
        expect(urlUtil.convertOpenaiToResponses("https://api.example.com/v1/chat/completions"))
            .toBe("https://api.example.com/v1/responses");
    });

    it("returns null for a base URL without the /chat/completions suffix", () => {
        expect(urlUtil.convertOpenaiToResponses("https://api.example.com/v1")).toBeNull();
    });

    it("returns null for a non-standard URL that embeds /chat/completions mid-path", () => {
        expect(urlUtil.convertOpenaiToResponses("https://api.example.com/chat/completions/v2")).toBeNull();
    });
});
