import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import requestActivityManager from "../../src/manager/requestActivityManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("requestActivityManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    it("createActivity + findByRecordId + updateActivities", async () => {
        // 不存在的 record_id 返回 null
        expect(await requestActivityManager.findByRecordId(99999)).toBeNull();

        await requestActivityManager.createActivity(1, "[]");

        const row = await requestActivityManager.findByRecordId(1);
        expect(row?.activities).toBe("[]");

        await requestActivityManager.updateActivities(1, '[{"stage":"result"}]');
        expect((await requestActivityManager.findByRecordId(1))?.activities).toBe('[{"stage":"result"}]');
    });
});
