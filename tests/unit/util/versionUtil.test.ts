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