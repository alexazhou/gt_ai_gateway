import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";

let adminToken: string;

// 构造 record 插入语句，created_at/updated_at 按驱动生成：
// sqlite 用 datetime('now','localtime', '-N day')，mysql 用 NOW() - INTERVAL N DAY
//
// 注意 must 用 localtime（P1-01）：应用侧写库用的是 formatDbDatetime(new Date())，即**本地时间**字符串；
// sqlite 的 datetime('now') 是 UTC，东八区会比本地时间早 8 小时，导致「今天」的记录被判成昨天，
// 统计用例就会假红（这不是业务 bug，是造数据方式与真实写入口径不一致）。
// tenant_id 落 main 主租户（多租户隔离：统计按当前视角租户过滤）
async function insertRecords(rows: [number, number, string, number][]): Promise<void> {
    const isMysql = process.env.DB_DRIVER === "mysql";
    const values = rows
        .map(([u, m, s, dayOffset]) => {
            const dt =
                dayOffset === 0
                    ? isMysql
                        ? "NOW()"
                        : "datetime('now', 'localtime')"
                    : isMysql
                        ? `NOW() - INTERVAL ${dayOffset} DAY`
                        : `datetime('now', 'localtime', '-${dayOffset} day')`;
            return `(${u}, ${m}, '${s}', (SELECT id FROM tenant WHERE name = 'main'), ${dt}, ${dt})`;
        })
        .join(",\n");
    await dbHelper.execute(
        `INSERT INTO record (user_id, model_id, status, tenant_id, created_at, updated_at)\nVALUES\n${values}`,
    );
}

describe("Stats API", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
        adminToken = await setupAdminUser();
    });

    describe("GET /stats/dashboard.json", () => {
        it("should calculate success rate based on today's requests only", async () => {
            await dbHelper.truncate();
            adminToken = await setupAdminUser();

            await insertRecords([
                [1, 101, "success", 0],
                [2, 102, "success", 0],
                [3, 103, "failed", 0],
                [4, 104, "failed", 1],
                [5, 105, "success", 1],
            ]);

            const response = await requestHelper.get("/stats/dashboard.json", adminToken);

            expect(response.status).toBe(200);
            expect(response.body.total_requests).toBe(5);
            expect(response.body.today_requests).toBe(3);
            expect(response.body.success_count).toBe(2);
            expect(response.body.failed_count).toBe(1);
            expect(response.body.success_rate).toBeCloseTo(2 / 3, 5);
        });

        it("should calculate active users and active models based on today's requests only", async () => {
            await dbHelper.truncate();
            adminToken = await setupAdminUser();

            await insertRecords([
                [11, 201, "success", 0],
                [11, 201, "failed", 0],
                [12, 202, "success", 0],
                [13, 203, "success", 1],
                [14, 204, "failed", 1],
            ]);

            const response = await requestHelper.get("/stats/dashboard.json", adminToken);

            expect(response.status).toBe(200);
            expect(response.body.today_requests).toBe(3);
            expect(response.body.active_users).toBe(2);
            expect(response.body.active_models).toBe(2);
        });

        it("should return null success rate and zero active counts when there are no requests today", async () => {
            await dbHelper.truncate();
            adminToken = await setupAdminUser();

            await insertRecords([
                [21, 301, "success", 2],
                [22, 302, "failed", 1],
            ]);

            const response = await requestHelper.get("/stats/dashboard.json", adminToken);

            expect(response.status).toBe(200);
            expect(response.body.total_requests).toBe(2);
            expect(response.body.today_requests).toBe(0);
            expect(response.body.success_count).toBe(0);
            expect(response.body.failed_count).toBe(0);
            expect(response.body.success_rate).toBeNull();
            expect(response.body.active_users).toBe(0);
            expect(response.body.active_models).toBe(0);
        });
    });
});
