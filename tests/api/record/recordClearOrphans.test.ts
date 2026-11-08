/**
 * 清理悬空数据 API 测试
 *
 * 验证：
 * - DELETE /record/clear-orphans 清掉「record 已不存在」的 payload 与 activity
 * - 现存记录的 payload / activity 一条都不能动（这是本功能最容易做错的地方）
 * - 非 root 一律 403（这两张附属表没有 tenant_id，只能全局清理，故必须是 root）
 *
 * 做法：先用真实请求造出「有 payload + activity」的记录，再**故意绕过接口**直接删
 * record 行，制造出存量孤儿（旧版本删除留下的那种残留），然后打接口验证。
 */
import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";


const ROOT_TOKEN = "root-token-123";

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


async function countRows(table: string): Promise<number> {
    const rows = await dbHelper.query<{ cnt: number | string }>(`SELECT COUNT(*) AS cnt FROM ${table}`);
    return Number(rows[0]?.cnt ?? 0);
}


async function payloadKeys(): Promise<string[]> {
    const rows = await dbHelper.query<{ object_key: string }>("SELECT object_key FROM storage_record");
    return rows.map(r => String(r.object_key));
}


async function activityRecordIds(): Promise<number[]> {
    const rows = await dbHelper.query<{ record_id: number | string }>("SELECT record_id FROM request_activity");
    return rows.map(r => Number(r.record_id));
}


/**
 * 绕过接口直接删 record 行，制造存量孤儿。
 *
 * 必须直接动库：现在的接口已经级联删干净了，造不出孤儿——而线上那些存量孤儿正是
 * 旧版本「只删 record」留下的，这个函数复现的正是那个现场。
 */
async function orphanRecord(recordId: number): Promise<void> {
    await dbHelper.execute("DELETE FROM record WHERE id = ?", [recordId]);
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

    testModelName = `record-orphan-model-${Date.now()}`;
    const model = await requestHelper.post(
        "/model/create.json",
        modelFixtures.createRandomModel(vendor.body.id, testModelName),
        adminToken,
    );
    expect(model.status).toBe(200);
}


describe("Record Clear Orphans API", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
        await setupModel();
    });

    it("should reject non-root with 403", async () => {
        // adminToken 是 admin（不是 root）：这两张表没有 tenant_id，只能全局清理，故必须挡掉
        const res = await requestHelper.del("/record/clear-orphans", adminToken);
        expect(res.status).toBe(403);
    });

    it("should reject unauthenticated request", async () => {
        const res = await requestHelper.request("/record/clear-orphans", { method: "DELETE" });
        expect(res.status).toBe(401);
    });

    it("should clear orphan payload and activity but keep surviving records untouched", async () => {
        // 前置清场：保证断言看到的是本用例造的数据
        await requestHelper.del("/record/clear-all", adminToken);

        const survivor = await createTestRecord();
        const doomed = await createTestRecord();

        // 前置：两条记录都真的有附属数据（否则后面的减法证明不了什么）
        const keysBefore = await payloadKeys();
        expect(keysBefore).toContain(`record/${survivor.id}`);
        expect(keysBefore).toContain(`record/${doomed.id}`);
        expect(await activityRecordIds()).toContain(Number(doomed.id));
        expect(await activityRecordIds()).toContain(Number(survivor.id));

        // 制造孤儿：只删 record 行，payload / activity 留着（旧版本就是这么留的）
        await orphanRecord(doomed.id);

        const res = await requestHelper.del("/record/clear-orphans", ROOT_TOKEN);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.success).toBe(true);
        // 恰好清了这一条孤儿，不是 0（假绿）也不是把活的一起清
        expect(res.body.cleared_payloads).toBe(1);
        expect(res.body.deleted_activities).toBe(1);

        // 孤儿没了
        const keysAfter = await payloadKeys();
        expect(keysAfter).not.toContain(`record/${doomed.id}`);
        expect(await activityRecordIds()).not.toContain(Number(doomed.id));

        // 存活的记录必须原封不动
        expect(keysAfter).toContain(`record/${survivor.id}`);
        expect(await activityRecordIds()).toContain(Number(survivor.id));

        const survivorRes = await requestHelper.get(`/record/${survivor.id}`, adminToken);
        expect(survivorRes.status).toBe(200);
        expect(survivorRes.body.request_data).not.toBeNull();
    });

    it("should report zero when there are no orphans", async () => {
        // 上一轮已清干净，此时不该再有孤儿；再调一次必须是 0，不能把存活数据当孤儿删
        const keysBefore = await payloadKeys();
        const activitiesBefore = await activityRecordIds();

        const res = await requestHelper.del("/record/clear-orphans", ROOT_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body.cleared_payloads).toBe(0);
        expect(res.body.deleted_activities).toBe(0);

        // 幂等：数据一条不少
        expect(await payloadKeys()).toEqual(keysBefore);
        expect(await activityRecordIds()).toEqual(activitiesBefore);
    });

    it("should clear multiple orphans at once", async () => {
        await requestHelper.del("/record/clear-all", adminToken);

        const survivor = await createTestRecord();
        const doomedA = await createTestRecord();
        const doomedB = await createTestRecord();
        await orphanRecord(doomedA.id);
        await orphanRecord(doomedB.id);

        const res = await requestHelper.del("/record/clear-orphans", ROOT_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body.cleared_payloads).toBe(2);
        expect(res.body.deleted_activities).toBe(2);

        const keysAfter = await payloadKeys();
        expect(keysAfter).toEqual([`record/${survivor.id}`]);
        expect(await activityRecordIds()).toEqual([Number(survivor.id)]);
    });

    it("should not touch storage keys outside the record/ prefix", async () => {
        // 前缀下若有别的命名（未来扩展），一律不动：宁可漏删，不可误删
        await requestHelper.del("/record/clear-all", adminToken);
        const survivor = await createTestRecord();

        await dbHelper.execute(
            "INSERT INTO storage_record (object_key, size_bytes, data) VALUES (?, ?, ?)",
            ["other/keep-me", 3, Buffer.from("abc")],
        );

        const res = await requestHelper.del("/record/clear-orphans", ROOT_TOKEN);
        expect(res.status).toBe(200);

        const keysAfter = await payloadKeys();
        expect(keysAfter).toContain("other/keep-me");
        expect(keysAfter).toContain(`record/${survivor.id}`);
        // 清理干净，避免污染后续用例
        await dbHelper.execute("DELETE FROM storage_record WHERE object_key = ?", ["other/keep-me"]);
    });

    /**
     * 跨页用例：孤儿条数超过一页（实现里每页 1000 条），必须一条不落地清掉。
     *
     * 这组数据专门用来卡住「翻页写错」的两类 bug：
     * - 用 `LIMIT/OFFSET` 翻页：边扫边删会让后面的行 offset 前移，成片跳过（只剩 1/2~1/3 被删）；
     * - 存活记录混在孤儿中间：把整页当孤儿删会误删存活 payload。
     *
     * 因此这里造 2499 条孤儿，并把一条**存活**记录的 key / activity 落在孤儿 id 区间正中，
     * 让它在第一页里与大量孤儿相邻 —— 误删与否一眼可见。
     */
    it("should clear orphans spanning multiple pages without skipping or over-deleting", async () => {
        await requestHelper.del("/record/clear-all", adminToken);
        // 直接清空两张附属表，保证下面断言的条数只来自本用例造的数据
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");

        const SURVIVOR_ID = 5000100;
        const ORPHAN_BASE = 5000001;
        const ORPHAN_COUNT = 2500;

        // 存活记录：record 行真实存在，payload / activity 落在孤儿 id 区间中间
        // tenant_id 落 main 主租户，否则 admin 视角（按租户过滤）查不到这条记录
        await dbHelper.execute(
            `INSERT INTO record (id, user_id, model_id, status, tenant_id, start_at) VALUES (${SURVIVOR_ID}, 1, NULL, 'success', (SELECT id FROM tenant WHERE name = 'main'), datetime('now'))`,
        );
        await dbHelper.execute(`INSERT INTO storage_record (object_key, size_bytes, data) VALUES ('record/${SURVIVOR_ID}', 1, 'x')`);
        await dbHelper.execute(`INSERT INTO request_activity (record_id, activities) VALUES (${SURVIVOR_ID}, '[]')`);

        const orphanIds: number[] = [];
        for (let i = 0; i < ORPHAN_COUNT; i++) {
            const id = ORPHAN_BASE + i;
            if (id !== SURVIVOR_ID) {
                orphanIds.push(id);
            }
        }

        // 分批插入，避免单条语句过大（值全部是数字字面量，无注入面）
        const INSERT_BATCH = 500;
        for (let i = 0; i < orphanIds.length; i += INSERT_BATCH) {
            const batch = orphanIds.slice(i, i + INSERT_BATCH);
            const payloadValues = batch.map(id => `('record/${id}', 1, 'x')`).join(",");
            await dbHelper.execute(`INSERT INTO storage_record (object_key, size_bytes, data) VALUES ${payloadValues}`);
            const activityValues = batch.map(id => `(${id}, '[]')`).join(",");
            await dbHelper.execute(`INSERT INTO request_activity (record_id, activities) VALUES ${activityValues}`);
        }

        // 前置：确实是跨页规模（> 2 页），否则这条用例证明不了翻页
        expect(orphanIds.length).toBe(ORPHAN_COUNT - 1);
        expect(await countRows("storage_record")).toBeGreaterThan(2000);

        const res = await requestHelper.del("/record/clear-orphans", ROOT_TOKEN);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.cleared_payloads).toBe(ORPHAN_COUNT - 1);
        expect(res.body.deleted_activities).toBe(ORPHAN_COUNT - 1);

        // 一条不落：只剩存活的那条
        expect(await payloadKeys()).toEqual([`record/${SURVIVOR_ID}`]);
        expect(await activityRecordIds()).toEqual([SURVIVOR_ID]);

        // 活着的记录连原文都还能读出来（不是只留了个 key）
        const survivorRes = await requestHelper.get(`/record/${SURVIVOR_ID}`, adminToken);
        expect(survivorRes.status).toBe(200);

        // 清场：把这条手工插入的记录删掉，避免污染其他测试文件
        await dbHelper.execute(`DELETE FROM record WHERE id = ${SURVIVOR_ID}`);
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");
    });
});
