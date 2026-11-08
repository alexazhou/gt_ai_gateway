/**
 * 清理悬空数据 API 测试
 *
 * 验证：
 * - `GET /record/clear-orphans/stats.json` 返回的分母与实际数据一致
 * - `POST /record/clear-orphans/step` 逐片清掉「record 已不存在」的 payload 与 activity
 * - 现存记录的 payload / activity 一条都不能动（这是本功能最容易做错的地方）
 * - 分片推进能跨多页清完，且不重扫、不跳过
 * - 非 root 一律 403（这两张附属表没有 tenant_id，只能全局清理，故必须是 root）
 *
 * 做法：先用真实请求造出「有 payload + activity」的记录，再**故意绕过接口**直接删
 * record 行，制造出存量孤儿（旧版本删除留下的那种残留），然后打接口验证。
 *
 * ## 两种模式下的分工
 *
 * 「孤儿到底删掉了哪几条」只能靠直接读 payload 存储来断言，而这在两种模式下是两套东西：
 * - node 模式：`storage_record` 表（本进程直连，可查可造）；
 * - worker 模式：R2（payload 存进了 wrangler dev 起的那份本地 R2，本测试进程**够不到**，
 *   也没有任何能按 key 枚举的接口）。
 *
 * 所以凡是需要直接检查 payload 存储的用例都只在 node 模式跑（`itNodeOnly`），
 * 它们覆盖的翻页 / 游标 / 不误删逻辑与存储位置无关——服务端代码只有一份。
 * worker 模式下 R2 侧的分页与删除由 `tests/integration/objectStorageService.node.test.ts`
 * 用 mock bucket 覆盖（含 R2 单次 list 上限、跨页续取）。
 * 两种模式都会跑的只有纯 HTTP 契约类用例：鉴权、参数校验、limit 收敛。
 */
import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import config from "../../config";


const ROOT_TOKEN = "root-token-123";

const IS_WORKER = config.TEST_MODE === "worker";
const IS_MYSQL = process.env.DB_DRIVER === "mysql";
/** 「当前时刻」的 SQL 写法：MySQL 用 NOW()，SQLite / D1 用 datetime('now') */
const NOW_SQL = IS_MYSQL ? "NOW()" : "datetime('now')";
/** 需要直接读写 payload 存储的用例：worker 模式够不到 R2，只在 node 模式跑（理由见文件头） */
const itNodeOnly = it.skipIf(IS_WORKER);

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
 *
 * 用拼字面量而不是参数绑定：worker 模式的测试适配器（`WorkerDBAdapter.run`）
 * 只把 `exec(sql)` 交给 `wrangler d1 execute`，**参数会被丢掉**；传 id 是数据库返回的整数，
 * 拼进 SQL 没有注入面。两种模式用同一段 SQL 才能保证造出来的现场一致。
 */
async function orphanRecord(recordId: number): Promise<void> {
    const id = Number(recordId);
    if (!Number.isInteger(id) || id < 0) {
        throw new Error(`orphanRecord: invalid record id ${recordId}`);
    }
    await dbHelper.execute(`DELETE FROM record WHERE id = ${id}`);
}


/**
 * 模拟前端：从第一片开始循环调 step，直到 done。
 *
 * 这是接口设计里「服务端无状态、游标由调用方持有」的直接体现——前端要做的就是这件事。
 * 返回累加后的总数，用例据此断言。
 *
 * @param pageSize 每片条数上限，用例里会调小以便用少量数据造出跨多片的效果
 */
async function runSteps(pageSize: number): Promise<{
    scannedPayloads: number;
    deletedPayloads: number;
    scannedActivities: number;
    deletedActivities: number;
    steps: number;
}> {
    let afterKey: string | null = null;
    let afterActivityId: number | null = null;
    let scannedPayloads = 0;
    let deletedPayloads = 0;
    let scannedActivities = 0;
    let deletedActivities = 0;
    let steps = 0;

    while (true) {
        const res = await requestHelper.post(
            "/record/clear-orphans/step",
            { after_key: afterKey, after_activity_id: afterActivityId, limit: pageSize },
            ROOT_TOKEN,
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        steps += 1;

        scannedPayloads += res.body.scanned_payloads;
        deletedPayloads += res.body.deleted_payloads;
        scannedActivities += res.body.scanned_activities;
        deletedActivities += res.body.deleted_activities;

        if (res.body.done) {
            return { scannedPayloads, deletedPayloads, scannedActivities, deletedActivities, steps };
        }

        afterKey = res.body.next_after_key;
        afterActivityId = res.body.next_after_activity_id;

        // 防死循环：接口若把游标重置回 null，这里会立刻暴露（而不是把测试挂死）
        expect(steps).toBeLessThan(100);
    }
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
        const statsRes = await requestHelper.get("/record/clear-orphans/stats.json", adminToken);
        expect(statsRes.status).toBe(403);

        const stepRes = await requestHelper.post("/record/clear-orphans/step", {}, adminToken);
        expect(stepRes.status).toBe(403);
    });

    it("should reject unauthenticated request", async () => {
        const statsRes = await requestHelper.request("/record/clear-orphans/stats.json", { method: "GET" });
        expect(statsRes.status).toBe(401);

        const stepRes = await requestHelper.request("/record/clear-orphans/step", { method: "POST" });
        expect(stepRes.status).toBe(401);
    });

    it("should reject invalid cursor parameters", async () => {
        const badLimit = await requestHelper.post(
            "/record/clear-orphans/step",
            { limit: -5 },
            ROOT_TOKEN,
        );
        expect(badLimit.status).toBe(400);

        const badKey = await requestHelper.post(
            "/record/clear-orphans/step",
            { after_key: 123 },
            ROOT_TOKEN,
        );
        expect(badKey.status).toBe(400);

        const badActivity = await requestHelper.post(
            "/record/clear-orphans/step",
            { after_activity_id: "abc" },
            ROOT_TOKEN,
        );
        expect(badActivity.status).toBe(400);
    });

    itNodeOnly("should report stats matching the actual row counts", async () => {
        await requestHelper.del("/record/clear-all", adminToken);
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");

        await createTestRecord();
        await createTestRecord();

        const res = await requestHelper.get("/record/clear-orphans/stats.json", ROOT_TOKEN);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        // 分母就是两张表的实际条数：进度条的准确性全靠它
        expect(res.body.payload_total).toBe(await countRows("storage_record"));
        expect(res.body.activity_total).toBe(await countRows("request_activity"));
        expect(res.body.payload_total).toBe(2);
        expect(res.body.activity_total).toBe(2);
        expect(res.body.page_size).toBeGreaterThan(0);
    });

    itNodeOnly("should clear orphan payload and activity but keep surviving records untouched", async () => {
        // 前置清场：保证断言看到的是本用例造的数据
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");

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

        const totals = await runSteps(1000);
        // 恰好清了这一条孤儿，不是 0（假绿）也不是把活的一起清
        expect(totals.deletedPayloads).toBe(1);
        expect(totals.deletedActivities).toBe(1);

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

    itNodeOnly("should report zero when there are no orphans", async () => {
        // 上一轮已清干净，此时不该再有孤儿；再跑一遍必须是 0，不能把存活数据当孤儿删
        const keysBefore = await payloadKeys();
        const activitiesBefore = await activityRecordIds();

        const totals = await runSteps(1000);
        expect(totals.deletedPayloads).toBe(0);
        expect(totals.deletedActivities).toBe(0);

        // 幂等：数据一条不少
        expect(await payloadKeys()).toEqual(keysBefore);
        expect(await activityRecordIds()).toEqual(activitiesBefore);
    });

    itNodeOnly("should clear multiple orphans at once", async () => {
        await requestHelper.del("/record/clear-all", adminToken);
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");

        const survivor = await createTestRecord();
        const doomedA = await createTestRecord();
        const doomedB = await createTestRecord();
        await orphanRecord(doomedA.id);
        await orphanRecord(doomedB.id);

        const totals = await runSteps(1000);
        expect(totals.deletedPayloads).toBe(2);
        expect(totals.deletedActivities).toBe(2);

        const keysAfter = await payloadKeys();
        expect(keysAfter).toEqual([`record/${survivor.id}`]);
        expect(await activityRecordIds()).toEqual([Number(survivor.id)]);
    });

    itNodeOnly("should not touch storage keys outside the record/ prefix", async () => {
        // 前缀下若有别的命名（未来扩展），一律不动：宁可漏删，不可误删
        await requestHelper.del("/record/clear-all", adminToken);
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");
        const survivor = await createTestRecord();

        // 同样拼字面量：worker 适配器会丢参数（见 orphanRecord 注释）
        await dbHelper.execute(
            "INSERT INTO storage_record (object_key, size_bytes, data) VALUES ('other/keep-me', 3, 'abc')",
        );

        await runSteps(1000);

        const keysAfter = await payloadKeys();
        expect(keysAfter).toContain("other/keep-me");
        expect(keysAfter).toContain(`record/${survivor.id}`);
        // 清理干净，避免污染后续用例
        await dbHelper.execute("DELETE FROM storage_record WHERE object_key = 'other/keep-me'");
    });

    /**
     * 跨片用例：数据量远超一片，必须一片不落地清掉。
     *
     * 用 pageSize=100 而不是实现里的默认 1000，是为了用不大的数据量就能覆盖「多片」路径
     * （否则要造上千条才能跨页）。这里造 2499 条孤儿 + 1 条存活，共 25 片。
     *
     * 这组数据专门用来卡住翻页写错的两类 bug：
     * - 用 `LIMIT/OFFSET` 翻页：边扫边删会让后面的行 offset 前移，成片跳过（只剩 1/2~1/3 被删）；
     * - 游标在一段扫完后被重置：先扫完的那段会被无限重扫（用例里有防死循环断言）。
     */
    itNodeOnly("should clear orphans spanning multiple steps without skipping or over-deleting", async () => {
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
            `INSERT INTO record (id, user_id, model_id, status, tenant_id, start_at) VALUES (${SURVIVOR_ID}, 1, NULL, 'success', (SELECT id FROM tenant WHERE name = 'main'), ${NOW_SQL})`,
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

        // 前置：确实是跨片规模，否则这条用例证明不了翻页
        expect(orphanIds.length).toBe(ORPHAN_COUNT - 1);
        expect(await countRows("storage_record")).toBeGreaterThan(2000);

        const totals = await runSteps(100);
        expect(totals.steps).toBeGreaterThan(20);
        // 一条不落：每片都以「本片增量」回报，累加后必须等于孤儿数
        expect(totals.scannedPayloads).toBe(ORPHAN_COUNT);
        expect(totals.deletedPayloads).toBe(ORPHAN_COUNT - 1);
        expect(totals.scannedActivities).toBe(ORPHAN_COUNT);
        expect(totals.deletedActivities).toBe(ORPHAN_COUNT - 1);

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

    /**
     * payload 与 activity 两段长度不对称时，先扫完的那段不能把游标重置成 null。
     *
     * 这是最容易漏的一处：两段各自维护游标，一段先扫完时另一段还在继续。若在该片把
     * `next_after_key` 回成 null，调用方会拿 null 回去、那段就从头重扫——`scanned` 虚高，
     * 而 `deleted` 看着正常，所以只断言「删了多少」的用例抓不到。
     *
     * 关键：payload 段里必须留**存活**的 key。若全是被删的孤儿，重扫时已经查不到东西、
     * 只会得到空页，虚高就测不出来。这里让存活 key 排在前面（id 更小），
     * 于是每多走一片 activity，就会把前面这些存活 key 再数一遍。
     */
    itNodeOnly("should not reset a cursor whose segment finished earlier than the other", async () => {
        await requestHelper.del("/record/clear-all", adminToken);
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");

        const ALIVE_BASE = 6000001;
        const ORPHAN_BASE = 6100001;
        const ALIVE_COUNT = 60;
        const ORPHAN_PAYLOAD_COUNT = 60;
        const ACTIVITY_COUNT = 300;
        const PAYLOAD_COUNT = ALIVE_COUNT + ORPHAN_PAYLOAD_COUNT;

        // 存活 payload：record 行真实存在，一段扫完后仍留在库里，重扫时会被再次数到
        for (let i = 0; i < ALIVE_COUNT; i++) {
            await dbHelper.execute(
                `INSERT INTO record (id, user_id, model_id, status, tenant_id, start_at) VALUES (${ALIVE_BASE + i}, 1, NULL, 'success', (SELECT id FROM tenant WHERE name = 'main'), ${NOW_SQL})`,
            );
        }
        const aliveValues = Array.from({ length: ALIVE_COUNT }, (_, i) => `('record/${ALIVE_BASE + i}', 1, 'x')`).join(",");
        await dbHelper.execute(`INSERT INTO storage_record (object_key, size_bytes, data) VALUES ${aliveValues}`);

        const orphanValues = Array.from({ length: ORPHAN_PAYLOAD_COUNT }, (_, i) => `('record/${ORPHAN_BASE + i}', 1, 'x')`).join(",");
        await dbHelper.execute(`INSERT INTO storage_record (object_key, size_bytes, data) VALUES ${orphanValues}`);

        for (let i = 0; i < ACTIVITY_COUNT; i += 500) {
            const batch = Array.from({ length: Math.min(500, ACTIVITY_COUNT - i) }, (_, j) => `(${ORPHAN_BASE + i + j}, '[]')`);
            await dbHelper.execute(`INSERT INTO request_activity (record_id, activities) VALUES ${batch.join(",")}`);
        }

        // 每片 50 条：payload 3 片扫完（120/50），activity 6 片扫完（300/50）
        const totals = await runSteps(50);

        // 关键断言：payload 只被检查了一遍。若游标被重置，这里会大于 PAYLOAD_COUNT
        expect(totals.scannedPayloads).toBe(PAYLOAD_COUNT);
        expect(totals.deletedPayloads).toBe(ORPHAN_PAYLOAD_COUNT);
        expect(totals.scannedActivities).toBe(ACTIVITY_COUNT);
        expect(totals.deletedActivities).toBe(ACTIVITY_COUNT);

        // 存活的 key 一条没动，孤儿全清
        expect(await countRows("storage_record")).toBe(ALIVE_COUNT);
        expect(await countRows("request_activity")).toBe(0);

        // 清场
        await dbHelper.execute(`DELETE FROM record WHERE id >= ${ALIVE_BASE} AND id < ${ALIVE_BASE + ALIVE_COUNT}`);
        await dbHelper.execute("DELETE FROM storage_record");
        await dbHelper.execute("DELETE FROM request_activity");
    });

    /**
     * 全接口版：不碰任何存储内部结构，只靠 stats 与 step 的回报断言。
     *
     * 两种模式都跑，而且对两者一视同仁——node 下 payload 在 `storage_record`，
     * worker 下在 R2，这条用例不关心它到底存哪儿，只关心「孤儿被清掉、存活的不动」。
     * worker 模式尤其需要它：R2 那条分支以前从未被端到端跑到，超大 limit 直接把 R2 的
     * `list()` 上限炸了出来（`MaxKeys params must be positive integer <= 1000`）。
     */
    it("should clear an orphan end to end through the API in either storage mode", async () => {
        await requestHelper.del("/record/clear-all", adminToken);

        const survivor = await createTestRecord();
        const doomed = await createTestRecord();

        // 制造孤儿：只删 record 行，payload / activity 留着
        await orphanRecord(doomed.id);

        const before = await requestHelper.get("/record/clear-orphans/stats.json", ROOT_TOKEN);
        expect(before.status, JSON.stringify(before.body)).toBe(200);
        // 造出来的两片 payload 都算在分母里（另可能有前序用例残留的孤儿）
        expect(before.body.payload_total).toBeGreaterThanOrEqual(2);

        const totals = await runSteps(1000);
        expect(totals.deletedPayloads).toBeGreaterThanOrEqual(1);
        expect(totals.deletedActivities).toBeGreaterThanOrEqual(1);

        // 只该剩下存活那条：孤儿（含前序残留）全清，说明整轮扫完了
        const after = await requestHelper.get("/record/clear-orphans/stats.json", ROOT_TOKEN);
        expect(after.status).toBe(200);
        expect(after.body.payload_total).toBe(1);

        // 幂等：再跑一轮不该有任何删除
        const again = await runSteps(1000);
        expect(again.deletedPayloads).toBe(0);
        expect(again.deletedActivities).toBe(0);

        // 存活记录的原文还能读出来（不是只留了个 key）
        const survivorRes = await requestHelper.get(`/record/${survivor.id}`, adminToken);
        expect(survivorRes.status).toBe(200);
        expect(survivorRes.body.request_data).not.toBeNull();
    });

    it("should cap limit at the configured maximum", async () => {
        // 超上限的 limit 会被收敛到上限，而不是直接报错：请求方传 1e9 也只搬一页
        const res = await requestHelper.post(
            "/record/clear-orphans/step",
            { limit: 1_000_000_000 },
            ROOT_TOKEN,
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
});
