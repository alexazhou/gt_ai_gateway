import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import userService from "../../../src/service/userService";
import rechargeRecordManager from "../../../src/manager/rechargeRecordManager";
import ormService from "../../../src/service/ormService";
import { SgUser } from "../../../src/model/sgUser";
import { RunMode } from "../../../src/constants";
import config from "../../config";
import dbHelper from "../../helpers/dbHelper";

/**
 * 金额口径的端到端判据：入参是「元」，落库的余额与充值记录必须是「整数微元」。
 *
 * 为什么要这条：`adjustBalance` 里「元 → 微元」的换算是唯一一步，写错（少乘 1e6 / 直接传元）
 * 不会抛错、类型也不变，只有断言到具体数值才会红。2026-11-26 的变异自证证明：
 * 去掉这步换算，balance API 那几个文件 36 例全绿 —— 那些用例断言的是余额，不看充值记录金额。
 */
describe("userService.adjustBalance 金额口径（integration，真库 + ORM）", () => {
    const USER_ID = 9;

    beforeAll(async () => {
        await ormService.init({ mode: RunMode.NODE, dbPath: config.DB_CONFIG.path });
    }, 60000);

    beforeEach(async () => {
        await dbHelper.truncate();
        await SgUser.query().create({
            id: USER_ID,
            name: "adjust-amount-user",
            token: "adjust-amount-token",
            type: "normal",
            status: "active",
            balance: 0,
        } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function balanceOf(): Promise<number> {
        const user = await SgUser.query().find(USER_ID);
        return Number(user!.balance);
    }

    async function rechargeAmounts(): Promise<number[]> {
        const { list } = await rechargeRecordManager.listRechargeRecords({ user_id: USER_ID });
        return list.map((r) => Number(r.amount));
    }

    it("充值 1 元 ⇒ 余额 +1000000 微元，充值记录 amount = 1000000", async () => {
        await userService.adjustBalance(USER_ID, 1, "recharge", "端到端判据", "admin");

        expect(await balanceOf()).toBe(1_000_000);
        expect(await rechargeAmounts()).toEqual([1_000_000]);
    });

    it("扣减 0.5 元 ⇒ 余额 -500000 微元，充值记录 amount = -500000（符号跟着走）", async () => {
        await userService.adjustBalance(USER_ID, 0.5, "recharge", "先充", "admin");
        await userService.adjustBalance(USER_ID, -0.5, "adjustment", "再扣", "admin");

        expect(await balanceOf()).toBe(0);
        // 最新一条在前：-0.5 元 → -500000 微元
        expect(await rechargeAmounts()).toEqual([-500_000, 500_000]);
    });

    it("非整数金额不丢精度：1.23 元 ⇒ 1230000 微元（余额与记录一致）", async () => {
        await userService.adjustBalance(USER_ID, 1.23, "recharge", "小数金额", "admin");

        expect(await balanceOf()).toBe(1_230_000);
        expect(await rechargeAmounts()).toEqual([1_230_000]);
    });
});
