import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import ruleManager from "../../src/manager/ruleManager";
import ruleService from "../../src/service/ruleService";
import { RuleType, UserType } from "../../src/constants";
import { SgUser } from "../../src/model/sgUser";
import { SgModel } from "../../src/model/sgModel";
import { SgVendor } from "../../src/model/sgVendor";
import customError from "../../src/customError";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";
import memoryRateLimitStore from "../../src/util/rule/memoryRateLimitStore";

describe("ruleService (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
        memoryRateLimitStore.clear();
        ruleService.invalidateCache();
    });

    function user(id: number, type: UserType = UserType.NORMAL): SgUser {
        return { id, type } as unknown as SgUser;
    }

    function model(id: number): SgModel {
        return { id } as unknown as SgModel;
    }

    function vendor(id: number): SgVendor {
        return { id } as unknown as SgVendor;
    }

    async function createRateLimit(scope: unknown, rpm: number, name = "rl") {
        return ruleManager.create({ type: RuleType.RATE_LIMIT, name, scope, config: { rpm }, enabled: true });
    }

    async function createAccessControl(scope: unknown, name = "ac") {
        return ruleManager.create({ type: RuleType.ACCESS_CONTROL, name, scope, config: {}, enabled: true });
    }

    it("rejects with AccessDeniedError when an forbid_access tree matches (whitelist via not in)", async () => {
        await createAccessControl({
            type: "and",
            values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "user_id", oper: "not in", values: [3, 4, 5] },
            ],
        });

        // 名单外用户 1 → 拒绝
        await expect(ruleService.matchAndCheck(user(1), model(5))).rejects.toBeInstanceOf(customError.AccessDeniedError);
        // 名单内用户 3 → 放行
        await expect(ruleService.matchAndCheck(user(3), model(5))).resolves.toBeUndefined();
        // 其他模型 → 放行
        await expect(ruleService.matchAndCheck(user(1), model(6))).resolves.toBeUndefined();
    });

    it("deny-wins: any of multiple forbid_access rules matching rejects", async () => {
        await createAccessControl({ type: "model_id", oper: "=", values: [5] });
        await createAccessControl({ type: "user_id", oper: "in", values: [1, 2] });

        // 用户 1 命中第二条规则
        await expect(ruleService.matchAndCheck(user(1), model(7))).rejects.toBeInstanceOf(customError.AccessDeniedError);
        // 用户 3 两条都不命中 → 放行
        await expect(ruleService.matchAndCheck(user(3), model(7))).resolves.toBeUndefined();
    });

    it("root bypasses all rules", async () => {
        await createRateLimit({ type: "const", values: [true] }, 1);
        await createAccessControl({ type: "const", values: [true] });

        await expect(ruleService.matchAndCheck(user(1, UserType.ROOT), model(5))).resolves.toBeUndefined();
    });

    it("forbid_access is checked before rate_limit (denied request consumes no quota)", async () => {
        await createRateLimit({ type: "model_id", oper: "=", values: [5] }, 1);
        await createAccessControl({
            type: "and",
            values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "user_id", oper: "=", values: [1] },
            ],
        });

        // 用户 1 被 403 拒绝，不消耗限流计数
        await expect(ruleService.matchAndCheck(user(1), model(5))).rejects.toBeInstanceOf(customError.AccessDeniedError);
        // 用户 2 仍保有完整配额（rpm=1 → 第一个请求放行）
        await expect(ruleService.matchAndCheck(user(2), model(5))).resolves.toBeUndefined();
        // 用户 2 第二个请求 → 限流
        await expect(ruleService.matchAndCheck(user(2), model(5))).rejects.toBeInstanceOf(customError.RateLimitError);
    });

    it("rate limit rejects after rpm quota exhausted", async () => {
        await createRateLimit({ type: "model_id", oper: "=", values: [5] }, 2);

        await expect(ruleService.matchAndCheck(user(1), model(5))).resolves.toBeUndefined();
        await expect(ruleService.matchAndCheck(user(2), model(5))).resolves.toBeUndefined();
        await expect(ruleService.matchAndCheck(user(3), model(5))).rejects.toBeInstanceOf(customError.RateLimitError);
    });

    it("rules with vendor_id are split to phase 2 (matchAndCheckVendor)", async () => {
        await createAccessControl({
            type: "and",
            values: [
                { type: "model_id", oper: "=", values: [5] },
                { type: "vendor_id", oper: "=", values: [9] },
            ],
        });

        // 阶段一不含 vendor_id 的规则 → 不拦截
        await expect(ruleService.matchAndCheck(user(1), model(5))).resolves.toBeUndefined();
        // 阶段二命中实际路由到的供应商 9 → 拒绝
        await expect(ruleService.matchAndCheckVendor(user(1), model(5), vendor(9))).rejects.toBeInstanceOf(customError.AccessDeniedError);
        // 路由到供应商 8 → 放行
        await expect(ruleService.matchAndCheckVendor(user(1), model(5), vendor(8))).resolves.toBeUndefined();
    });

    it("vendor rate limit throws RateLimitError with failoverEligible=true", async () => {
        await createRateLimit({ type: "vendor_id", oper: "=", values: [9] }, 1);

        await expect(ruleService.matchAndCheckVendor(user(1), model(5), vendor(9))).resolves.toBeUndefined();
        const err = await ruleService.matchAndCheckVendor(user(1), model(5), vendor(9)).catch(e => e);
        expect(err).toBeInstanceOf(customError.RateLimitError);
        expect(err.failoverEligible).toBe(true);
    });

    it("validateRule rejects invalid payloads", () => {
        expect(() => ruleService.validateRule({ type: "unknown", scope: { type: "const", values: [true] }, config: {} })).toThrow(/Unsupported rule type/);
        expect(() => ruleService.validateRule({ type: "rate_limit", scope: { type: "and", values: [] }, config: { rpm: 10 } })).toThrow(/non-empty/);
        expect(() => ruleService.validateRule({ type: "rate_limit", scope: { type: "const", values: [true] }, config: { rpm: -1 } })).toThrow(/rpm/);
        expect(() => ruleService.validateRule({ type: "rate_limit", scope: { type: "const", values: [true] }, config: { rpm: 1.5 } })).toThrow(/rpm/);
        expect(() => ruleService.validateRule({ type: "forbid_access", scope: { type: "const", values: [true] }, config: { extra: 1 } })).toThrow(/empty config/);
        // 合法载荷不抛
        expect(() => ruleService.validateRule({ type: "rate_limit", scope: { type: "const", values: [true] }, config: { rpm: null } })).not.toThrow();
        expect(() => ruleService.validateRule({ type: "forbid_access", scope: { type: "const", values: [true] }, config: {} })).not.toThrow();
    });
});
