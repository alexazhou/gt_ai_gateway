import { afterEach, describe, expect, it, vi } from "vitest";
import ormService from "../../../src/service/ormService";

/**
 * P2-14：`_updateD1Binding` 去掉「整段 try/catch 静默吞」。
 *
 * 背景：Cloudflare Workers 里每个请求的 env.DB 有独立 I/O 上下文，需要在每次请求时
 * 把当前 binding 挂到 knex 的 D1 client 上。原实现走
 * `sutando.getInstance().manager["default"].connector.client`，在当前 sutando 版本下拿不到 client，
 * 被 try/catch 吞掉后这段保护**其实一直是 no-op** —— 现象是查询期炸
 * "Cannot perform I/O on behalf of a different request"，根因完全不可见。
 *
 * 现在换成 `getKnex()?.client`，取不到就硬失败。这里把三种形态钉住：
 * 拿得到（正常赋值）、拿不到（必须抛）、拿到空壳（必须抛）。
 */

const updateD1Binding = (ormService as any)._updateD1Binding.bind(ormService);

describe("P2-14 _updateD1Binding", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("client 就绪：把当前请求的 D1 binding 挂到 client 上", () => {
        const client: Record<string, unknown> = {};
        const spies = vi.spyOn(ormService as any, "getKnex").mockReturnValue({ client });

        const binding = { prepare: () => undefined };
        updateD1Binding(binding);

        expect(client.d1Driver, "d1Driver 必须指向当前请求的 binding").toBe(binding);
        expect(client.driver).toBe(binding);
        expect(spies).toHaveBeenCalled();
    });

    it("完全拿不到 knex 实例：必须抛错（不能静默变成 no-op）", () => {
        vi.spyOn(ormService as any, "getKnex").mockReturnValue(undefined);

        expect(() => updateD1Binding({}))
            .toThrow(/无法更新 D1 binding/);
    });

    it("拿到实例但没有 client：必须抛错，且错误里提示排查 sutando 结构", () => {
        vi.spyOn(ormService as any, "getKnex").mockReturnValue({});

        expect(() => updateD1Binding({}))
            .toThrow(/sutando knex client 未就绪/);
    });

    it("client 已存在时不做任何数据库 I/O（只做属性赋值）", () => {
        const client: Record<string, unknown> = {};
        vi.spyOn(ormService as any, "getKnex").mockReturnValue({ client });

        // 传入的 binding 只要是个对象即可；方法是同步的，不应该 await 任何东西
        const result = updateD1Binding({} as any);

        expect(result).toBeUndefined();
        expect(Object.keys(client).sort()).toEqual(["d1Driver", "driver"]);
    });
});
