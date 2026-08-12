import { describe, it, expect } from "vitest";
import { SgVendorModel } from "../../../src/model/sgVendorModel";
import { ApiFormat } from "../../../src/constants";

/**
 * SgVendorModel.allowed_formats 语义测试
 *
 * allowed_formats 为 null/空（未指定）时，getSupportedFormats() 返回 null，
 * 由路由层回退到 vendor 按 URL 自动判断支持的格式；
 * 非空时作为硬限制白名单，原样返回列表，只允许列表内的格式。
 */

function makeVendorModel(allowedFormats: string | null): SgVendorModel {
    const vm = new SgVendorModel();
    vm.allowed_formats = allowedFormats;
    return vm;
}


describe("SgVendorModel.getSupportedFormats", () => {
    it("returns null when allowed_formats is unset, letting routing fall back to vendor URL detection", () => {
        const vm = makeVendorModel(null);
        expect(vm.getSupportedFormats()).toBeNull();
    });

    it("returns null when allowed_formats is empty string", () => {
        const vm = makeVendorModel("");
        expect(vm.getSupportedFormats()).toBeNull();
    });

    it("returns the parsed allowlist as a hard restriction", () => {
        const vm = makeVendorModel(JSON.stringify([ApiFormat.OPENAI, ApiFormat.ANTHROPIC]));
        expect(vm.getSupportedFormats()).toEqual([ApiFormat.OPENAI, ApiFormat.ANTHROPIC]);
    });

    it("returns empty array for an explicitly empty allowlist, blocking all formats", () => {
        const vm = makeVendorModel("[]");
        expect(vm.getSupportedFormats()).toEqual([]);
    });
});
