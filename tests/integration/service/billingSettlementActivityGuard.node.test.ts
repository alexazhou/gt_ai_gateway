import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import billingSettlementService from "../../../src/service/billingSettlementService";
import ormService from "../../../src/service/ormService";
import requestActivityManager from "../../../src/manager/requestActivityManager";
import { SgRecord } from "../../../src/model/sgRecord";
import { SgUser } from "../../../src/model/sgUser";
import { RequestActivityStage, RunMode, SgRecordStatus } from "../../../src/constants";
import config from "../../config";
import dbHelper from "../../helpers/dbHelper";

/**
 * #332 回归：结算侧给「已删 record」补写孤儿活动行。
 *
 * 现场（#326 取证）：流式请求的后台结算走 `waitUntil`，要等上游空闲超时（~180s）才 fire；
 * 而 `record` 可能早已被删除 / 被 truncate 清掉。结算里写 `request_activity` 原本是无条件 UPSERT、
 * 不校验 record 还在不在 ⇒ 给已删记录补回一行孤儿活动（`recordDelete.test.ts` 的全表
 * `COUNT(*)` 因此偶发 +1，红成 `expected 1 to be +0`）。
 *
 * 本文件钉的就是这条守卫：**record 不存在 ⇒ 不写活动行，且留一条可诊断日志**；
 * record 存在时行为不变（活动行照写、重复结算仍只 1 行）。
 *
 * 为什么在 integration 而不是 unit（2026-11-26 迁移）：判据是**真表的行数与唯一约束**
 * （`request_activity.record_id` UNIQUE + UPSERT 幂等），mock 断言不出「只有 1 行」。
 * 造数据与断言一律走 ORM（`SgUser` / `SgRecord` / `requestActivityManager`），
 * 结算本身也走 `ormService.runAtomically` 的真实适配器 —— 不再出现「按环境变量拼方言、
 * 却喂给另一种驱动」的组合，sqlite 门与 MySQL 门跑的是同一份代码。
 */
describe("#332 结算侧活动写入的存在性守卫（integration，真库 + ORM）", () => {
    const RECORD_ID = 42;
    const USER_ID = 7;
    const INITIAL_BALANCE = 1_000_000;

    beforeAll(async () => {
        // 进程内自己连库：真服务（src/local.ts）启动时会 init 一次，测试进程不带
        await ormService.init({ mode: RunMode.NODE, dbPath: config.DB_CONFIG.path });
    }, 60000);

    beforeEach(async () => {
        await dbHelper.truncate();
        await SgUser.query().create({
            id: USER_ID,
            name: "settle-guard-user",
            token: "settle-guard-token",
            type: "normal",
            status: "active",
            balance: INITIAL_BALANCE,
        } as any);
        await SgRecord.query().create({
            id: RECORD_ID,
            user_id: USER_ID,
            status: SgRecordStatus.PROCESSING,
            cost: 0,
        } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** 一次带 RESULT 活动的结算（等价于 #326 里 record_id=40 的那次迟到结算） */
    function settleWithActivity() {
        return billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.FAILED,
            cost: 0,
            endAt: new Date(),
            chargeUserId: null,
            activity: {
                stage: RequestActivityStage.RESULT,
                message: "上游超时（upstream_timeout）",
            },
        });
    }

    async function activityOfRecord() {
        return await requestActivityManager.findByRecordId(RECORD_ID);
    }

    async function balanceOf(): Promise<number> {
        const user = await SgUser.query().find(USER_ID);
        return Number(user!.balance);
    }

    /** 模拟「record 已被删」：连 ORM 一起删掉，守卫里的存在性读自然读到 null */
    async function deleteRecordRow(): Promise<void> {
        const record = await SgRecord.query().find(RECORD_ID);
        expect(record, "前置：record 行必须存在，否则测的不是删除路径").toBeTruthy();
        await record!.delete();
    }

    it("正：record 仍在时照旧写入活动行（守卫不误伤正常结算）", async () => {
        await settleWithActivity();

        const activity = await activityOfRecord();
        expect(activity, "活动行应写入").toBeTruthy();
        const activities = JSON.parse(activity!.activities) as { stage: string; message: string }[];
        expect(activities).toHaveLength(1);
        expect(activities[0].stage).toBe(RequestActivityStage.RESULT);
        expect(activities[0].message).toContain("upstream_timeout");
    });

    it("反：record 已被删除时不写活动行，且留一条可诊断日志（核心判据）", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await deleteRecordRow();

        await settleWithActivity();

        // ① 没有孤儿活动行 —— 全表 COUNT 保持 0（正是 recordDelete 断言的形式）
        expect(await requestActivityManager.countAll()).toBe(0);
        // ② 不是静默吞掉：日志里能指认 record id 与阶段
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0][0]);
        expect(message).toContain(String(RECORD_ID));
        expect(message).toContain("已被删除");
        expect(message).toContain(RequestActivityStage.RESULT);
    });

    it("反：record 已删时结算本身不抛错（后台 waitUntil 链路不能被守卫打断）", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await deleteRecordRow();

        await expect(settleWithActivity()).resolves.toEqual({ cost: 0 });
        expect(await requestActivityManager.countAll()).toBe(0);
    });

    it("record 已删时不扣费、不留活动行（余额与活动表都干净）", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await deleteRecordRow();

        await billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.SUCCESS,
            cost: 0.01,
            endAt: new Date(),
            chargeUserId: USER_ID,
            activity: { stage: RequestActivityStage.RESULT, message: "结算" },
        });

        expect(await balanceOf()).toBe(INITIAL_BALANCE);
        expect(await requestActivityManager.countAll()).toBe(0);
    });

    it("同一 record 重复结算（waitUntil 重试）活动行仍只有 1 行（幂等 UPSERT 不变）", async () => {
        await settleWithActivity();
        await settleWithActivity();

        expect(await requestActivityManager.countAll()).toBe(1);
    });

    it("存在时写入 / 删除后跳过：同一份代码下两条路径可由同一条判据区分", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await settleWithActivity();                 // record 在 → 写
        expect(await requestActivityManager.countAll()).toBe(1);

        // 模拟删除路径：记录与活动行一起被清掉
        const activity = await activityOfRecord();
        await activity!.delete();
        expect(await requestActivityManager.countAll()).toBe(0);

        await deleteRecordRow();
        await settleWithActivity();                 // 迟到结算 → 不写
        expect(await requestActivityManager.countAll()).toBe(0);
    });
});
