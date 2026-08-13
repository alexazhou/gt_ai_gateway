import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgModel } from "../../src/model/sgModel";
import { ModelRoutingMode, SgRecordStatus } from "../../src/constants";
import modelManager from "../../src/manager/modelManager";
import recordManager from "../../src/manager/recordManager";
import userManager from "../../src/manager/userManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("recordManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    function buildModel(name: string) {
        return new SgModel({
            name,
            routing_mode: ModelRoutingMode.SINGLE,
            routing_config: {
                upstreams: [{ vendor_id: 1, enabled: true }],
                failover: { enabled: true },
                load_balance_strategy: "user",
            },
        });
    }

    async function createTestUser() {
        return await userManager.create({
            name: "tester",
            token: `token-${Math.random()}`,
            type: "normal" as any,
        });
    }

    async function createRecord(status = SgRecordStatus.SUCCESS) {
        const user = await createTestUser();
        const model = await modelManager.save(buildModel(`m-${Math.random()}`));
        return await recordManager.create({
            user_id: user.id,
            model_id: model.id,
            vendor_id: null,
            vendor_model_name: null,
            status,
            client_format: null,
            upstream_format: null,
            first_token_latency: null,
            start_at: new Date(),
            end_at: null,
            cost: 0,
        });
    }

    it("create + findById + latest + count + deleteById", async () => {
        const record = await createRecord(SgRecordStatus.INIT);

        expect((await recordManager.findById(record.id))?.status).toBe(SgRecordStatus.INIT);
        expect((await recordManager.latest(10, true)).length).toBe(1);
        expect(await recordManager.count()).toBe(1);

        expect(await recordManager.deleteById(record.id)).toBe(true);
        expect(await recordManager.count()).toBe(0);
        expect(await recordManager.deleteById(record.id)).toBe(false);
    });

    it("update strips response_data (not a table column)", async () => {
        const record = await createRecord(SgRecordStatus.INIT);

        await recordManager.update(record.id, {
            status: SgRecordStatus.SUCCESS,
            response_data: "should-not-reach-table",
        });

        const refreshed = await recordManager.findById(record.id);
        expect(refreshed?.status).toBe(SgRecordStatus.SUCCESS);
    });

    it("update writes table columns", async () => {
        const record = await createRecord(SgRecordStatus.INIT);
        await recordManager.update(record.id, {
            status: SgRecordStatus.SUCCESS,
            cost: 42,
        });
        const refreshed = await recordManager.findById(record.id);
        expect(refreshed?.status).toBe(SgRecordStatus.SUCCESS);
        expect(refreshed?.cost).toBe(42);
    });

    it("latest with summaryOnly selects summary columns", async () => {
        await createRecord();
        const rows = await recordManager.latest(10, true);
        expect(rows.length).toBe(1);
    });

    it("list filters by status / time / userIds / modelIds", async () => {
        const user = await createTestUser();
        const model = await modelManager.save(buildModel("m-filter"));
        const record = await recordManager.create({
            user_id: user.id,
            model_id: model.id,
            vendor_id: null,
            vendor_model_name: null,
            status: SgRecordStatus.SUCCESS,
            client_format: null,
            upstream_format: null,
            first_token_latency: null,
            start_at: new Date(),
            end_at: null,
            cost: 0,
        });

        expect((await recordManager.list({ status: SgRecordStatus.SUCCESS, pageSize: 10, offset: 0 })).total).toBe(1);
        expect((await recordManager.list({ status: SgRecordStatus.FAILED, pageSize: 10, offset: 0 })).total).toBe(0);

        // 时间过滤使用记录实际的 created_at（数据库存储为本地时间字符串 "YYYY-MM-DD HH:MM:SS"）
        const refreshed = await recordManager.findById(record.id);
        const createdAtDate = refreshed?.created_at as Date;
        const pad = (n: number) => String(n).padStart(2, "0");
        const createdAt = `${createdAtDate.getFullYear()}-${pad(createdAtDate.getMonth() + 1)}-${pad(createdAtDate.getDate())} ${pad(createdAtDate.getHours())}:${pad(createdAtDate.getMinutes())}:${pad(createdAtDate.getSeconds())}`;
        expect((await recordManager.list({ startTime: createdAt, pageSize: 10, offset: 0 })).total).toBe(1);
        expect((await recordManager.list({ endTime: createdAt, pageSize: 10, offset: 0 })).total).toBe(1);
        expect((await recordManager.list({ startTime: "2099-01-01 00:00:00", pageSize: 10, offset: 0 })).total).toBe(0);

        expect((await recordManager.list({ userIds: [user.id], pageSize: 10, offset: 0 })).total).toBe(1);
        expect((await recordManager.list({ userIds: [999999], pageSize: 10, offset: 0 })).total).toBe(0);
        expect((await recordManager.list({ modelIds: [model.id], pageSize: 10, offset: 0 })).total).toBe(1);
        expect((await recordManager.list({ modelIds: [999999], pageSize: 10, offset: 0 })).total).toBe(0);
        // 空数组：跳过 whereIn 过滤，返回全部
        expect((await recordManager.list({ userIds: [], pageSize: 10, offset: 0 })).total).toBe(1);
        expect((await recordManager.list({ modelIds: [], pageSize: 10, offset: 0 })).total).toBe(1);
    });

    it("list with summaryOnly + recent + deleteAll", async () => {
        await createRecord();
        const summarized = await recordManager.list({ pageSize: 10, offset: 0, summaryOnly: true });
        expect(summarized.total).toBe(1);

        const recent = await recordManager.recent(5);
        expect(recent.length).toBe(1);

        await recordManager.deleteAll();
        expect(await recordManager.count()).toBe(0);
    });
});
