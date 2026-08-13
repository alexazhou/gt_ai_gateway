import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import rechargeRecordManager from "../../src/manager/rechargeRecordManager";
import userManager from "../../src/manager/userManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("rechargeRecordManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    async function createTestUser() {
        return await userManager.create({
            name: "tester",
            token: `token-${Math.random()}`,
            type: "normal" as any,
        });
    }

    it("create + listRechargeRecords + getRechargeRecord", async () => {
        const user = await createTestUser();
        await rechargeRecordManager.create({
            user_id: user.id,
            amount: 100,
            type: "recharge",
            remark: "充值",
            operator: "admin",
        });

        const { list, total } = await rechargeRecordManager.listRechargeRecords({ user_id: user.id });
        expect(total).toBe(1);
        expect(list.length).toBe(1);
        expect(list[0].amount).toBe(100);

        const record = await rechargeRecordManager.getRechargeRecord(Number(list[0].id));
        expect(record?.remark).toBe("充值");
    });

    it("listRechargeRecords filters by type", async () => {
        const user = await createTestUser();
        await rechargeRecordManager.create({ user_id: user.id, amount: 10, type: "recharge" });
        await rechargeRecordManager.create({ user_id: user.id, amount: -5, type: "adjustment" });

        const recharge = await rechargeRecordManager.listRechargeRecords({ user_id: user.id, type: "recharge" });
        expect(recharge.total).toBe(1);
        expect(recharge.list[0].amount).toBe(10);
    });

    it("listRechargeRecords with empty query returns all records", async () => {
        const user1 = await createTestUser();
        const user2 = await createTestUser();
        await rechargeRecordManager.create({ user_id: user1.id, amount: 10, type: "recharge" });
        await rechargeRecordManager.create({ user_id: user2.id, amount: -5, type: "adjustment" });

        // 不传任何过滤条件：user_id / type 分支均跳过，返回全部
        const { list, total } = await rechargeRecordManager.listRechargeRecords({});
        expect(total).toBe(2);
        expect(list.length).toBe(2);
    });
});
