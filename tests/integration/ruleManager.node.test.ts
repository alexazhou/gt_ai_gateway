import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import ruleManager from "../../src/manager/ruleManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";

describe("ruleManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    function buildRule(overrides: Record<string, any> = {}) {
        return {
            type: "rate_limit",
            name: "test-rule",
            scope: { type: "model_id", oper: "=", values: [5] },
            config: { rpm: 10 },
            enabled: true,
            ...overrides,
        };
    }

    it("create + findById with scope/config JSON round-trip", async () => {
        const rule = await ruleManager.create(buildRule());
        const found = await ruleManager.findById(rule.id);

        expect(found?.name).toBe("test-rule");
        expect(found?.type).toBe("rate_limit");
        expect(found?.scope).toEqual({ type: "model_id", oper: "=", values: [5] });
        expect(found?.config).toEqual({ rpm: 10 });
        expect(found?.enabled).toBe(true);
    });

    it("listEnabled returns only enabled rules", async () => {
        await ruleManager.create(buildRule());
        await ruleManager.create(buildRule({ name: "disabled", enabled: false }));

        const rules = await ruleManager.listEnabled();
        expect(rules.length).toBe(1);
        expect(rules[0].name).toBe("test-rule");
    });

    it("listRules pagination + keyword filter", async () => {
        await ruleManager.create(buildRule({ name: "alpha" }));
        await ruleManager.create(buildRule({ name: "beta" }));

        const { list, total } = await ruleManager.listRules({ keyword: "alpha", pageSize: 10, offset: 0 });
        expect(total).toBe(1);
        expect(list.length).toBe(1);
        expect(list[0].name).toBe("alpha");
    });

    it("update + delete", async () => {
        const rule = await ruleManager.create(buildRule());

        const updated = await ruleManager.update(rule.id, { enabled: false });
        expect(updated?.enabled).toBe(false);
        expect(updated?.name).toBe("test-rule");

        expect(await ruleManager.deleteRule(rule.id)).toBe(true);
        expect(await ruleManager.findById(rule.id)).toBeNull();
        expect(await ruleManager.deleteRule(rule.id)).toBe(false);
        expect(await ruleManager.update(999, {})).toBeNull();
    });

    it("cache invalidate listeners are notified on CRUD", async () => {
        let notified = 0;
        const listener = () => { notified += 1; };
        ruleManager.onInvalidate(listener);

        const rule = await ruleManager.create(buildRule());
        await ruleManager.update(rule.id, { name: "renamed" });
        await ruleManager.deleteRule(rule.id);

        expect(notified).toBe(3);
    });
});
