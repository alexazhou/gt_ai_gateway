import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import { SgRecordStatus } from "../constants";
import ormService from "../service/ormService";
import { parsePaginationQuery } from "../util/pagination";

function toSafeNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function dashboardStats(c: Context) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCutoff = today.toISOString().slice(0, 19).replace("T", " ");

    // 拆成两条 SQL：
    // 1. 今日数据：WHERE 过滤后走 idx_record_created_at 索引，只回表今天的少量行
    // 2. 总请求数：单独 COUNT(*) 走覆盖索引，不读主表
    const todaySql = `
        SELECT
            COUNT(*) AS today_requests,
            SUM(CASE WHEN status = '${SgRecordStatus.SUCCESS}' THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN status = '${SgRecordStatus.FAILED}' THEN 1 ELSE 0 END) AS failed_count,
            COUNT(DISTINCT user_id) AS active_users,
            COUNT(DISTINCT model_id) AS active_models
        FROM record
        WHERE created_at >= '${todayCutoff}'
    `;
    const totalSql = `SELECT COUNT(*) AS total_requests FROM record`;

    const [todayRow, totalRow] = await Promise.all([
        Promise.resolve(ormService.dbAdapter.prepare(todaySql).first()),
        Promise.resolve(ormService.dbAdapter.prepare(totalSql).first()),
    ]) as [Record<string, unknown> | undefined, Record<string, unknown> | undefined];

    const totalRequests = toSafeNumber(totalRow?.total_requests);
    const todayTotalRequests = toSafeNumber(todayRow?.today_requests);
    const successCount = toSafeNumber(todayRow?.success_count);
    const failedCount = toSafeNumber(todayRow?.failed_count);
    const activeUsers = toSafeNumber(todayRow?.active_users);
    const activeModels = toSafeNumber(todayRow?.active_models);
    const successRate = todayTotalRequests > 0 ? successCount / todayTotalRequests : null;

    return c.json({
        total_requests: totalRequests,
        success_count: successCount,
        failed_count: failedCount,
        success_rate: successRate,
        active_users: activeUsers,
        active_models: activeModels,
        today_requests: todayTotalRequests,
    });
}

async function recentRecords(c: Context) {
    const query = c.req.query();
    const { pageSize } = parsePaginationQuery(query, 10);

    const records = await SgRecord.query()
        .orderBy('id', 'desc')
        .limit(pageSize)
        .get();

    // 简化返回数据
    const simplified = records.map(r => ({
        id: r.id,
        user_id: r.user_id,
        model_id: r.model_id,
        status: r.status,
        created_at: r.created_at,
    }));

    return c.json(simplified);
}

export default {
    dashboardStats,
    recentRecords,
};
