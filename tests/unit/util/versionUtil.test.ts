import { describe, it, expect, beforeEach, afterEach } from "vitest";
import versionUtil from "../../../src/util/versionUtil";
import packageJson from "../../../package.json";

describe("versionUtil.getVersion", () => {
    const originalEnv = process.env.APP_VERSION;

    beforeEach(() => {
        delete process.env.APP_VERSION;
    });

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.APP_VERSION;
        } else {
            process.env.APP_VERSION = originalEnv;
        }
    });

    it("returns package.json version when APP_VERSION is unset", () => {
        expect(versionUtil.getVersion()).toBe(packageJson.version);
    });

    it("returns APP_VERSION when set in process.env", () => {
        process.env.APP_VERSION = "dev-20260821";
        expect(versionUtil.getVersion()).toBe("dev-20260821");
    });

    it("trims surrounding whitespace from APP_VERSION", () => {
        process.env.APP_VERSION = "  dev-1.0  ";
        expect(versionUtil.getVersion()).toBe("dev-1.0");
    });

    it("env object param (c.env) takes precedence over process.env", () => {
        process.env.APP_VERSION = "from-process";
        expect(versionUtil.getVersion({ APP_VERSION: "from-env" })).toBe("from-env");
    });

    it("falls back to package.json version when env object has no APP_VERSION", () => {
        process.env.APP_VERSION = "from-process";
        expect(versionUtil.getVersion({})).toBe("from-process");
        delete process.env.APP_VERSION;
        expect(versionUtil.getVersion({})).toBe(packageJson.version);
    });
});

describe("versionUtil.isNewerVersion", () => {
    it("纯数字版本：latest 主干更高才视为有更新", () => {
        expect(versionUtil.isNewerVersion("1.8.6", "1.8.7")).toBe(true);
        expect(versionUtil.isNewerVersion("1.8.7", "1.8.6")).toBe(false);
        expect(versionUtil.isNewerVersion("1.8.7", "1.8.10")).toBe(true);
        expect(versionUtil.isNewerVersion("1.8.10", "1.8.7")).toBe(false);
    });

    it("当前为更新的 prerelease：1.8.7-beta2 比正式版 1.8.6 新，不提示更新", () => {
        expect(versionUtil.isNewerVersion("1.8.7-beta2", "1.8.6")).toBe(false);
        expect(versionUtil.isNewerVersion("1.8.7-beta2", "1.8.6.0")).toBe(false);
    });

    it("同主干：beta < 正式版，beta 用户应收到正式版升级提示", () => {
        expect(versionUtil.isNewerVersion("1.8.7-beta2", "1.8.7")).toBe(true);
        expect(versionUtil.isNewerVersion("1.8.7", "1.8.7-beta2")).toBe(false);
        expect(versionUtil.isNewerVersion("1.8.7-beta2", "1.8.8")).toBe(true);
    });

    it("主干低于 latest 的 prerelease：当前正式版 1.8.7 vs latest 1.8.8-beta1 视为有更新", () => {
        expect(versionUtil.isNewerVersion("1.8.7", "1.8.8-beta1")).toBe(true);
    });

    it("相等版本与 v 前缀不干扰比较", () => {
        expect(versionUtil.isNewerVersion("1.8.7", "1.8.7")).toBe(false);
        expect(versionUtil.isNewerVersion("v1.8.7", "v1.8.7")).toBe(false);
        expect(versionUtil.isNewerVersion("1.8.7", "v1.8.6")).toBe(false);
        expect(versionUtil.isNewerVersion("v1.8.7", "1.8.8")).toBe(true);
    });
});