import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import configManager from "../../src/manager/configManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("configManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    it("set (create) + get + set (update) + getAll", async () => {
        await configManager.set("test_key", "value1");

        expect((await configManager.get("test_key"))?.value).toBe("value1");
        expect(await configManager.get("missing_key")).toBeNull();

        await configManager.set("test_key", "value2");
        expect((await configManager.get("test_key"))?.value).toBe("value2");

        const all = await configManager.getAll();
        const values = Object.fromEntries(all.map(c => [c.name, c.value]));
        expect(values["test_key"]).toBe("value2");
    });
});
