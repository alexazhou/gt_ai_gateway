import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import billingSettlementService from "../../../src/service/billingSettlementService";
import billingUtil from "../../../src/util/protocolUtil/billingUtil";
import ormService from "../../../src/service/ormService";
import recordService from "../../../src/service/recordService";
import configService from "../../../src/service/configService";
import { SgRecord } from "../../../src/model/sgRecord";
import { SgUser } from "../../../src/model/sgUser";
import { RunMode, SgRecordStatus } from "../../../src/constants";
import config from "../../config";
import dbHelper from "../../helpers/dbHelper";

/**
 * P0-4 回归：记录结算 + 扣费的原子性。
 *
 * 为什么在 integration 而不是 unit（2026-11-26 迁移）：判据是**真表的行值与余额**，
 * 且 `runAtomically` 的方言由适配器决定；自己造表 + 注入 `SQLiteAdapter` 会把
 * 「按环境变量拼方言、却喂给另一种驱动」的组合造出来（#332 就是这么把 MySQL 门打红的）。
 * 造数据与断言一律走 ORM（`SgUser` / `SgRecord`），结算走 `ormService` 的真实适配器。
 */
describe("P0-4 结算原子性（integration，真库 + ORM）", () => {
    const RECORD_ID = 42;
    const USER_ID = 7;
    const INITIAL_BALANCE = 1_000_000; // 1 元 = 1e6 微元

    beforeAll(async () => {
        await ormService.init({ mode: RunMode.NODE, dbPath: config.DB_CONFIG.path });
    }, 60000);

    beforeEach(async () => {
        await dbHelper.truncate();
        await SgUser.query().create({
            id: USER_ID,
            name: "settle-atomic-user",
            token: "settle-atomic-token",
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

    async function balanceOf(): Promise<number> {
        const user = await SgUser.query().find(USER_ID);
        return Number(user!.balance);
    }

    async function recordOf() {
        const record = await SgRecord.query().find(RECORD_ID);
        expect(record, "前置：record 行必须存在").toBeTruthy();
        return record!;
    }

    function settleSuccess(cost: number, chargeUserId: number | null = USER_ID) {
        return billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.SUCCESS,
            usage: JSON.stringify({ prompt_tokens: 10, completion_tokens: 20 }),
            cost,
            endAt: new Date(),
            firstTokenLatency: 123,
            chargeUserId,
        });
    }

    it("首次结算：record 置 success + 余额按微元精确扣减", async () => {
        const cost = 0.000123; // 123 微元
        await settleSuccess(cost);

        const record = await recordOf();
        expect(record.status).toBe("success");
        // ORM 的 cost 经 MicroAmountCast 转换，读回来是「元」口径；微元精确落库由下面那条 SQL 参数断言看守
        expect(record.cost).toBeCloseTo(cost, 9);
        expect(Number(record.first_token_latency)).toBe(123);
        expect(record.end_at).toBeTruthy();

        expect(await balanceOf()).toBe(INITIAL_BALANCE - 123);
    });

    it("同一 record 重复结算（waitUntil 重试 / 重复 finalize）只扣一次费", async () => {
        const cost = 0.0005;
        await settleSuccess(cost);
        const afterFirst = await balanceOf();

        await settleSuccess(cost);
        await settleSuccess(cost);

        // 余额不再变化：守卫读到 record 已是 success
        expect(await balanceOf()).toBe(afterFirst);
        expect(await balanceOf()).toBe(INITIAL_BALANCE - billingUtil.toUnits(cost));
    });

    it("chargeUserId 为 null（root / 计费关闭 / 失败请求）时不扣费但 record 仍结算", async () => {
        await settleSuccess(0.0009, null);

        expect((await recordOf()).status).toBe("success");
        expect(await balanceOf()).toBe(INITIAL_BALANCE);
    });

    it("失败结算：写 failed_code、cost=0、余额不变", async () => {
        await billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.FAILED,
            cost: 0,
            failedCode: "upstream_error",
            endAt: new Date(),
            chargeUserId: null,
        });

        const record = await recordOf();
        expect(record.status).toBe("failed");
        expect(record.failed_code).toBe("upstream_error");
        expect(record.cost).toBe(0);
        expect(await balanceOf()).toBe(INITIAL_BALANCE);
    });

    it("扣费语句排在 record UPDATE 之前，且带「尚未结算」守卫", async () => {
        const adapter = ormService.dbAdapter;
        const captured: { sql: string; params?: unknown[] }[][] = [];
        const original = adapter.runAtomically.bind(adapter);
        vi.spyOn(adapter, "runAtomically").mockImplementation(async (statements: any) => {
            captured.push(statements);
            return original(statements);
        });

        await settleSuccess(0.01);

        expect(captured).toHaveLength(1);
        const statements = captured[0];
        expect(statements).toHaveLength(2);

        // ① 扣费语句在前（顺序错了幂等守卫就会失效）
        expect(statements[0].sql).toContain("balance = balance -");
        expect(statements[0].sql).toContain("(SELECT COALESCE(status, '') FROM record WHERE id = ?) <> ?");
        // ② 守卫参数必须是 success 状态字面量
        expect(statements[0].params).toEqual([
            billingUtil.toUnits(0.01),
            expect.any(String),
            USER_ID,
            RECORD_ID,
            SgRecordStatus.SUCCESS,
        ]);

        // ③ record 收尾在后
        expect(statements[1].sql).toContain("UPDATE record SET");
        expect(statements[1].sql).toContain("status = ?");
        expect(statements[1].params?.at(-1)).toBe(RECORD_ID);
    });

    it("事务内不读配置（isModuleBillingEnabled 在事务外取）", async () => {
        const configSpy = vi.spyOn(configService, "isModuleBillingEnabled");

        await settleSuccess(0.01);

        // settleRecord 自身不读配置；调用方（responseHandlerService）在事务外读
        expect(configSpy).not.toHaveBeenCalled();
    });

    it("response_data 在事务之前写入（对象存储幂等，不属于同库事务）", async () => {
        const order: string[] = [];
        vi.spyOn(recordService, "storeResponsePayload").mockImplementation(async () => {
            order.push("storePayload");
        });
        vi.spyOn(ormService.dbAdapter, "runAtomically").mockImplementation(() => {
            order.push("atomicWrite");
        });

        await billingSettlementService.settleRecord({
            recordId: RECORD_ID,
            status: SgRecordStatus.SUCCESS,
            cost: 0,
            endAt: new Date(),
            responseData: '{"ok":true}',
            chargeUserId: null,
        });

        expect(order).toEqual(["storePayload", "atomicWrite"]);
    });

    it("批内任一语句失败则整体回滚（钱账一致）", async () => {
        // 直接验证原子原语：第一条成功、第二条失败 → 全部回滚。
        // better-sqlite3 是同步抛，MySQL 是 rejects，包一层 async 才能同时接住两种。
        await expect(async () => {
            await ormService.dbAdapter.runAtomically([
                { sql: "UPDATE user SET balance = balance - ? WHERE id = ?", params: [500, USER_ID] },
                { sql: "UPDATE not_exist_table SET x = 1" },
            ] as any);
        }).rejects.toThrow();

        expect(await balanceOf()).toBe(INITIAL_BALANCE);
    });
});
