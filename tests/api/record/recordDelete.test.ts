/**
 * Record Delete API Tests
 *
 * 验证：
 * - DELETE /record/:id 删除单条记录
 * - DELETE /record/clear-payload 清除请求记录 payload
 * - DELETE /record/clear-all 删除所有记录
 *
 * 关于 worker 模式：payload 在 worker 下存 R2（`storage_record` 表根本不会被写），
 * 所以「payload 是否随 record 一起清掉」不能靠查 `storage_record` 断言，
 * 改为走接口读回（`GET /record/:id` 的 request_data / response_data 为 null）。
 * `request_activity` 在两种模式下都是表数据，断言方式一致。
 */
import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import config from "../../config";


/** worker 模式下 payload 落在 R2，`storage_record` 表始终为空，不做行数断言 */
const PAYLOAD_IN_TABLE = config.TEST_MODE !== "worker";


let adminToken: string;
let testUserToken: string;
let testModelName: string;


async function createTestRecord(): Promise<any> {
    const chatRes = await requestHelper.post(
        "/llm/v1/chat/completions",
        mockHelper.generateOpenAIChatRequest({ model: testModelName, stream: false }),
        testUserToken,
    );
    expect(chatRes.status, JSON.stringify(chatRes.body)).toBe(200);

    const latestRes = await requestHelper.get("/record/latest.json?limit=1", adminToken);
    expect(latestRes.status, JSON.stringify(latestRes.body)).toBe(200);
    expect(latestRes.body.length).toBeGreaterThan(0);
    return latestRes.body[0];
}


async function getRecordCount(): Promise<number> {
    const res = await requestHelper.get("/record/list.json", adminToken);
    expect(res.status).toBe(200);
    return res.body.total;
}


/**
 * 直接查库统计「随 record 一起应该被清掉」的两张附属表。
 *
 * 用 SQL 而不是走接口：接口层面根本看不到这两张表，历史用例只断言 record 计数归零，
 * 正是漏删 storage_record / request_activity 却能一直绿的原因。
 */
async function countRows(table: "request_activity" | "storage_record"): Promise<number> {
    const rows = await dbHelper.query<{ cnt: number | string }>(`SELECT COUNT(*) AS cnt FROM ${table}`);
    return Number(rows[0]?.cnt ?? 0);
}


async function assertCascadeCleared(): Promise<void> {
    expect(await countRows("request_activity")).toBe(0);
    if (PAYLOAD_IN_TABLE) {
        expect(await countRows("storage_record")).toBe(0);
    }
}


async function assertRecordPayload(recordId: number, hasPayload: boolean): Promise<void> {
    const res = await requestHelper.get(`/record/${recordId}`, adminToken);
    expect(res.status).toBe(200);

    if (hasPayload) {
        expect(res.body.request_data).not.toBeNull();
        expect(res.body.response_data).not.toBeNull();
        return;
    }

    expect(res.body.request_data).toBeNull();
    expect(res.body.response_data).toBeNull();
}


async function setupModel(): Promise<void> {
    const user = await requestHelper.post(
        "/user/create.json",
        mockHelper.generateUser(),
        adminToken,
    );
    expect(user.status).toBe(200);
    testUserToken = user.body.token;

    const vendor = await requestHelper.post(
        "/vendor/create.json",
        vendorFixtures.VENDOR_FIXTURES.openai(),
        adminToken,
    );
    expect(vendor.status).toBe(200);

    testModelName = `record-delete-model-${Date.now()}`;
    const model = await requestHelper.post(
        "/model/create.json",
        modelFixtures.createRandomModel(vendor.body.id, testModelName),
        adminToken,
    );
    expect(model.status).toBe(200);
}


describe("Record Delete API", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
        await setupModel();
    });

    describe("DELETE /record/:id", () => {
        it("should delete a single record", async () => {
            const record = await createTestRecord();

            const res = await requestHelper.del(`/record/${record.id}`, adminToken);
            expect(res.status).toBe(200);
        });

        it("should cascade-delete payload and activity of that record", async () => {
            // 先清空，保证断言看到的是「本条记录」的附属数据，而不是历史残留
            await requestHelper.del("/record/clear-all", adminToken);

            const record = await createTestRecord();
            await assertRecordPayload(record.id, true);

            const activityRes = await requestHelper.get(`/record/${record.id}/activity.json`, adminToken);
            expect(activityRes.status).toBe(200);
            expect(activityRes.body.activities.length).toBeGreaterThan(0);

            expect(await countRows("request_activity")).toBeGreaterThan(0);
            if (PAYLOAD_IN_TABLE) {
                expect(await countRows("storage_record")).toBeGreaterThan(0);
            }

            const res = await requestHelper.del(`/record/${record.id}`, adminToken);
            expect(res.status).toBe(200);

            // 只删 record 会让这两张表留下永久孤儿数据
            await assertCascadeCleared();
        });

        it("should return 404 for non-existent record", async () => {
            const res = await requestHelper.del("/record/999999", adminToken);
            expect(res.status).toBe(404);
        });

        it("should return 400 for invalid id", async () => {
            const res = await requestHelper.del("/record/abc", adminToken);
            expect(res.status).toBe(400);
        });
    });

    describe("DELETE /record/clear-payload", () => {
        it("should clear all record payloads", async () => {
            const record = await createTestRecord();
            await assertRecordPayload(record.id, true);

            const res = await requestHelper.del("/record/clear-payload", adminToken);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.cleared).toBeGreaterThan(0);

            await assertRecordPayload(record.id, false);
        });
    });

    describe("DELETE /record/clear-all", () => {
        it("should delete all records", async () => {
            await createTestRecord();
            await createTestRecord();
            await createTestRecord();
            const countBefore = await getRecordCount();
            expect(countBefore).toBeGreaterThanOrEqual(3);

            const res = await requestHelper.del("/record/clear-all", adminToken);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.deleted).toBeGreaterThanOrEqual(3);

            // All records deleted
            expect(await getRecordCount()).toBe(0);
        });

        it("should cascade-delete storage_record and request_activity", async () => {
            await createTestRecord();
            await createTestRecord();

            // 前置：确有附属数据（否则后面的 0 是假绿）
            if (PAYLOAD_IN_TABLE) {
                expect(await countRows("storage_record")).toBeGreaterThan(0);
            }
            expect(await countRows("request_activity")).toBeGreaterThan(0);

            const res = await requestHelper.del("/record/clear-all", adminToken);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.cleared_payloads).toBeGreaterThan(0);
            expect(res.body.deleted_activities).toBeGreaterThan(0);

            await assertCascadeCleared();
        });
    });
});
