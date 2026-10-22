import { RequestActivityStage, ActivityLevel } from "../constants";
import requestActivityManager from "../manager/requestActivityManager";
import type { SqlStatement } from "../util/dbAdapterUtil";


export interface RequestActivityEntry {
    stage: RequestActivityStage;
    level: ActivityLevel;
    message: string;
    details?: Record<string, unknown>;
    ts: number;
}


/** 待追加的活动内容（ts 由写入侧补） */
export interface RequestActivityInput {
    stage: RequestActivityStage;
    message: string;
    details?: Record<string, unknown>;
    level?: ActivityLevel;
}


/**
 * 批量读活动时的分片大小：一次 `WHERE record_id IN (...)` 最多带多少个 id。
 * 取 87 是因为 **D1 单语句绑定变量上限 100**，留余量给以后新增条件（P2-27 同源问题）。
 */
const ACTIVITY_READ_CHUNK = 87;


async function readActivities(recordId: number): Promise<RequestActivityEntry[]> {
    const row = await requestActivityManager.findByRecordId(recordId);
    if (!row) {
        return [];
    }
    try {
        const parsed = JSON.parse(row.activities ?? "[]");
        return Array.isArray(parsed) ? parsed as RequestActivityEntry[] : [];
    } catch (e) {
        console.warn(`[requestActivityService] Failed to parse activities for record ${recordId}:`, e);
        return [];
    }
}


/**
 * 计算「追加一条活动后」的完整 JSON 串，但不写库。
 * 供结算事务复用：读改写里的"读"必须在事务外完成，
 * 事务内只留一条幂等 upsert 语句（见 billingSettlementService）。
 */
async function buildAppendedActivities(recordId: number, entry: RequestActivityInput): Promise<string> {
    const activities = await readActivities(recordId);
    activities.push({
        stage: entry.stage,
        level: entry.level ?? ActivityLevel.INFO,
        message: entry.message,
        details: entry.details,
        ts: Date.now(),
    });
    return JSON.stringify(activities);
}


// 追加一条活动消息（读改写，upsert by record_id）
async function append(
    recordId: number,
    stage: RequestActivityStage,
    message: string,
    details?: Record<string, unknown>,
    level: ActivityLevel = ActivityLevel.INFO,
): Promise<void> {
    try {
        const activitiesJson = await buildAppendedActivities(recordId, { stage, message, details, level });
        const row = await requestActivityManager.findByRecordId(recordId);

        // created_at / updated_at 由 ORM 自动维护（与其他模型一致）
        if (row) {
            await requestActivityManager.updateActivities(recordId, activitiesJson);
        } else {
            await requestActivityManager.createActivity(recordId, activitiesJson);
        }
    } catch (e) {
        // 活动日志写入必须是 best-effort：失败绝不能导致请求失败
        console.warn(`[requestActivityService] Failed to append activity for record ${recordId}:`, e);
    }
}


async function getByRecordId(recordId: number): Promise<RequestActivityEntry[]> {
    return await readActivities(recordId);
}


/** 当前是否 MySQL 方言（UPSERT 语法不同）；worker/D1 与 node/sqlite 同走 SQLite 语法 */
function isMysqlDialect(): boolean {
    return process.env.DB_DRIVER === "mysql";
}


/**
 * 构造「按 record_id 追加活动」的幂等 UPSERT 语句（只构造不执行）。
 * request_activity.record_id 有唯一约束，读改写里的「读」必须在批处理外完成，
 * 批内只留这一条 UPSERT —— 与 billingSettlementService 结算事务同一口径。
 */
function buildActivityUpsertStatement(recordId: number, activitiesJson: string, now: string): SqlStatement {
    if (isMysqlDialect()) {
        return {
            sql: "INSERT INTO request_activity (record_id, activities, created_at, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE activities = ?, updated_at = ?",
            params: [recordId, activitiesJson, now, now, activitiesJson, now],
        };
    }
    return {
        sql: "INSERT INTO request_activity (record_id, activities, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET activities = excluded.activities, updated_at = excluded.updated_at",
        params: [recordId, activitiesJson, now, now],
    };
}


/**
 * 批量构造「给多条记录追加同一条活动」的 UPSERT 语句（P2-27）。
 *
 * 逐条 `append()` 是每条 3 次数据库往返（读两次 + 写一次）：孤儿回收一次 250 条就是 750 次往返，
 * Worker 下直接打爆 D1 的 subrequest 上限 —— 表现不是一条能看懂的报错，而是请求被重置
 * （测试侧看到的是 `ECONNRESET`）。所以这里改为：分片批量读现有活动 → 内存拼 JSON →
 * 交给调用方与记录更新同批一次写入。
 *
 * 单条语句绑定变量：4 个（sqlite）/ 6 个（mysql），与 record 的批量 UPDATE 不同量级。
 */
async function buildAppendedStatements(
    recordIds: number[],
    entry: RequestActivityInput,
    now: string,
): Promise<SqlStatement[]> {
    const statements: SqlStatement[] = [];
    if (recordIds.length === 0) {
        return statements;
    }

    const activityRow = new Map<number, string>();
    for (let i = 0; i < recordIds.length; i += ACTIVITY_READ_CHUNK) {
        const chunk = recordIds.slice(i, i + ACTIVITY_READ_CHUNK);
        const rows = await requestActivityManager.findByRecordIds(chunk);
        for (const row of rows) {
            activityRow.set(Number(row.record_id), row.activities ?? "[]");
        }
    }

    for (const recordId of recordIds) {
        const current = activityRow.get(recordId);
        let activities: RequestActivityEntry[] = [];
        try {
            const parsed = JSON.parse(current ?? "[]");
            activities = Array.isArray(parsed) ? parsed as RequestActivityEntry[] : [];
        } catch (e) {
            // 存量 JSON 损坏不阻塞回收：按覆盖写处理，保留一条日志便于排查
            console.warn(`[requestActivityService] Failed to parse activities for record ${recordId}:`, e);
        }
        activities.push({
            stage: entry.stage,
            level: entry.level ?? ActivityLevel.INFO,
            message: entry.message,
            details: entry.details,
            ts: Date.now(),
        });
        statements.push(buildActivityUpsertStatement(recordId, JSON.stringify(activities), now));
    }

    return statements;
}


export default {
    append,
    buildAppendedActivities,
    buildAppendedStatements,
    getByRecordId,
};
