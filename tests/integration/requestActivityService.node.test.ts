import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import requestActivityService from "../../src/service/requestActivityService";
import { RequestActivityStage, ActivityLevel } from "../../src/constants";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("requestActivityService (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    it("appends activities in order and reads them back", async () => {
        await requestActivityService.append(1, RequestActivityStage.ROUTING, "路由选择", {
            vendor_id: 7,
        });
        await requestActivityService.append(1, RequestActivityStage.UPSTREAM_ATTEMPT, "发起上游请求", {
            vendor_id: 7,
        });
        await requestActivityService.append(1, RequestActivityStage.RESULT, "请求成功", {
            status: "success",
        }, ActivityLevel.INFO);

        const activities = await requestActivityService.getByRecordId(1);
        expect(activities).toHaveLength(3);
        expect(activities.map((a) => a.stage)).toEqual([
            RequestActivityStage.ROUTING,
            RequestActivityStage.UPSTREAM_ATTEMPT,
            RequestActivityStage.RESULT,
        ]);
        expect(activities[0].details).toEqual({ vendor_id: 7 });
        expect(activities[0].level).toBe("info");
        expect(activities[0].ts).toBeTypeOf("number");
        // ts 单调递增（追加顺序）
        expect(activities[2].ts).toBeGreaterThanOrEqual(activities[1].ts);
    });

    it("upserts by record_id across appends and maintains created_at", async () => {
        await requestActivityService.append(42, RequestActivityStage.ROUTING, "路由选择");
        await requestActivityService.append(42, RequestActivityStage.FAILOVER, "切换", undefined, ActivityLevel.WARN);

        const rows = await dbHelper.query<any>(
            "SELECT record_id, activities, created_at, updated_at FROM request_activity WHERE record_id = ?",
            [42],
        );
        expect(rows).toHaveLength(1);
        const parsed = JSON.parse(rows[0].activities);
        expect(parsed).toHaveLength(2);
        expect(parsed[1].stage).toBe(RequestActivityStage.FAILOVER);
        expect(parsed[1].level).toBe("warn");

        // created_at / updated_at 与其他模型一致，由 ORM 自动维护
        expect(rows[0].created_at).toBeTruthy();
        expect(rows[0].updated_at).toBeTruthy();
    });

    it("returns an empty array for a record with no activities", async () => {
        const activities = await requestActivityService.getByRecordId(999);
        expect(activities).toEqual([]);
    });

    it("swallows write failures and does not throw", async () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const originalQuery = (await import("../../src/model/sgRequestActivity")).SgRequestActivity.query;

        // 让 append 内部抛错，验证 best-effort 不向外抛
        const throwingQuery = () => {
            throw new Error("db unavailable");
        };
        (await import("../../src/model/sgRequestActivity")).SgRequestActivity.query = throwingQuery as any;

        try {
            await expect(
                requestActivityService.append(1, RequestActivityStage.ROUTING, "路由选择"),
            ).resolves.toBeUndefined();
        } finally {
            (await import("../../src/model/sgRequestActivity")).SgRequestActivity.query = originalQuery;
            spy.mockRestore();
        }
    });
});
