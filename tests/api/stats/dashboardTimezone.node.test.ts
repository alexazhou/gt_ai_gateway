import { beforeAll, describe, expect, it } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";

/**
 * P1-01 验收门：`GET /stats/dashboard.json` 的「今日」边界必须按**本地时区**算。
 *
 * 现状（修复前）：`statsController.dashboardStats` 用
 *   `new Date(); setHours(0,0,0,0); toISOString().slice(0,19)`
 * 取今日零点的**UTC**表示，而 record 表里的 `created_at` 是**本地时间**文本
 * （`recordManager.formatDbDatetime`）。东八区下二者差 8 小时：
 * 本地 00:00 = UTC 前一天 16:00 → cutoff 提前 8 小时 → **昨天 16:00 之后的记录会被算进今天**。
 *
 * ⚠️ UTC 运行环境的盲区：当进程 TZ=UTC 时「本地零点」和「UTC 零点」一致，这个 bug 完全看不出来。
 * 原有 `tests/api/stats/stats.test.ts` 的种子又用 `datetime('now', '-1 day')`（DB 侧算的整天偏移），
 * 恰好也绕过了边界，所以一直绿。**本文件必须在 `TZ=Asia/Shanghai` 下跑才算数**：
 *   `TZ=Asia/Shanghai npm run backend:test:node -- tests/api/stats/dashboardTimezone.node.test.ts`
 * 断言本身与运行时区无关（「昨天 20:00 不能算今天」在任何时区都成立），因此不 skip、不 hardcode 偏移。
 */

let adminToken: string;

/** 与 recordManager.formatDbDatetime 同格式：'YYYY-MM-DD HH:mm:ss'，按**本地**时区算 */
function formatDbDatetime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对「今天本地零点」的偏移小时数取时间点 */
function hoursFromLocalMidnight(hours: number): Date {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return new Date(midnight.getTime() + hours * 3600_000);
}

async function insertRecordAt(createdAt: Date, status = "success"): Promise<void> {
    const ts = formatDbDatetime(createdAt);
    await dbHelper.execute(
        `INSERT INTO record (user_id, model_id, status, tenant_id, created_at, updated_at)
         VALUES (1, 101, '${status}', (SELECT id FROM tenant WHERE name = 'main'), '${ts}', '${ts}')`,
    );
}

describe("GET /stats/dashboard.json - 今日边界按本地时区（P1-01）", () => {
    beforeAll(async () => {
        adminToken = await setupAdminUser();
    });

    it("昨天 20:00（本地）的记录不得计入今日统计", async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        // 今天 00:01 一条（应计入）、昨天 20:00 一条（不得计入）
        await insertRecordAt(hoursFromLocalMidnight(1 / 60));
        await insertRecordAt(hoursFromLocalMidnight(-4));

        const response = await requestHelper.get("/stats/dashboard.json", adminToken);

        expect(response.status).toBe(200);
        expect(response.body.total_requests, "总数不受今日边界影响").toBe(2);
        expect(
            response.body.today_requests,
            "昨天 20:00 的请求被算进了今日：cutoff 用了 UTC 零点而非本地零点",
        ).toBe(1);
        expect(response.body.success_count).toBe(1);
    });

    it("昨天 23:59（本地）不计入，今天 00:01（本地）计入", async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        await insertRecordAt(hoursFromLocalMidnight(-1 / 60)); // 昨天 23:59
        await insertRecordAt(hoursFromLocalMidnight(1 / 60)); // 今天 00:01

        const response = await requestHelper.get("/stats/dashboard.json", adminToken);

        expect(response.body.today_requests).toBe(1);
        expect(response.body.failed_count).toBe(0);
    });

    it("今日零点的记录计入（>= cutoff，边界值不能被漏掉）", async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        await insertRecordAt(hoursFromLocalMidnight(0), "failed");

        const response = await requestHelper.get("/stats/dashboard.json", adminToken);

        expect(response.body.today_requests).toBe(1);
        expect(response.body.failed_count).toBe(1);
    });

    it("统计口径与 /record/latest 的可见记录一致（同一时区口径，不出现自相矛盾）", async () => {
        await dbHelper.truncate();
        await setupAdminUser();
        await insertRecordAt(hoursFromLocalMidnight(-4)); // 昨天 20:00
        await insertRecordAt(hoursFromLocalMidnight(2)); // 今天 02:00

        const [stats, latest] = await Promise.all([
            requestHelper.get("/stats/dashboard.json", adminToken),
            requestHelper.get("/record/latest.json?limit=10", adminToken),
        ]);

        const records = Array.isArray(latest.body) ? latest.body : [];
        expect(records).toHaveLength(2);
        expect(stats.body.today_requests).toBe(1);
        expect(stats.body.total_requests).toBe(records.length);
    });
});
