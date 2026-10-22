import { RequestActivityStage, ActivityLevel } from "../constants";
import requestActivityManager from "../manager/requestActivityManager";


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


export default {
    append,
    buildAppendedActivities,
    getByRecordId,
};
