import { SgRequestActivity } from "../model/sgRequestActivity";
import { RequestActivityStage, ActivityLevel } from "../constants";


export interface RequestActivityEntry {
    stage: RequestActivityStage;
    level: ActivityLevel;
    message: string;
    details?: Record<string, unknown>;
    ts: number;
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
        const row = await SgRequestActivity.query().where("record_id", recordId).first();
        let activities: RequestActivityEntry[] = [];
        if (row) {
            try {
                const parsed = JSON.parse(row.activities ?? "[]");
                if (Array.isArray(parsed)) {
                    activities = parsed as RequestActivityEntry[];
                }
            } catch (e) {
                console.warn(`[requestActivityService] Failed to parse activities for record ${recordId}:`, e);
            }
        }

        activities.push({
            stage,
            level,
            message,
            details,
            ts: Date.now(),
        });
        const activitiesJson = JSON.stringify(activities);

        // created_at / updated_at 由 ORM 自动维护（与其他模型一致）
        if (row) {
            await SgRequestActivity.query().where("record_id", recordId).update({
                activities: activitiesJson,
            });
        } else {
            await SgRequestActivity.query().create({
                record_id: recordId,
                activities: activitiesJson,
            });
        }
    } catch (e) {
        // 活动日志写入必须是 best-effort：失败绝不能导致请求失败
        console.warn(`[requestActivityService] Failed to append activity for record ${recordId}:`, e);
    }
}


async function getByRecordId(recordId: number): Promise<RequestActivityEntry[]> {
    const row = await SgRequestActivity.query().where("record_id", recordId).first();
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


export default {
    append,
    getByRecordId,
};
