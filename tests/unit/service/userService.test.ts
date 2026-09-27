import { describe, expect, it } from "vitest";
import userService from "../../../src/service/userService";
import { PLACEHOLDER_ROOT_TOKEN } from "../../../src/constants";

/**
 * root token 的判定。
 *
 * 随仓库公开的占位值（文档、docker-compose、wrangler 示例里统一使用的 your-root-token-here）
 * 一旦被当成有效的 root token，任何看过仓库的人都能接管管理面，所以它必须等同于「未配置」。
 */
describe("userService root token", () => {
    it("不把公开的占位值当作 root token", async () => {
        // 值写死一遍：就算有人把常量改掉或删掉，这条也要红
        expect(await userService.isRootToken("your-root-token-here", "your-root-token-here")).toBe(false);

        expect(await userService.isRootToken(PLACEHOLDER_ROOT_TOKEN, PLACEHOLDER_ROOT_TOKEN)).toBe(false);
        expect(userService.isRootTokenConfigured(PLACEHOLDER_ROOT_TOKEN)).toBe(false);
    });

    it("未配置（空 / undefined）时 root 无效", async () => {
        expect(await userService.isRootToken("any-token", "")).toBe(false);
        expect(await userService.isRootToken("any-token", undefined)).toBe(false);
        expect(userService.isRootTokenConfigured("")).toBe(false);
        expect(userService.isRootTokenConfigured(undefined)).toBe(false);
    });

    it("自己设置的 token 仍然有效", async () => {
        const token = "a-real-random-token";
        expect(await userService.isRootToken(token, token)).toBe(true);
        expect(userService.isRootTokenConfigured(token)).toBe(true);
    });

    it("token 与 root token 不同时不认", async () => {
        expect(await userService.isRootToken("other-token", "a-real-random-token")).toBe(false);
    });
});
