import { RequestActivityStage, ActivityLevel } from "../constants";
import requestActivityManager from "../manager/requestActivityManager";


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
        const row = await requestActivityManager.findByRecordId(recordId);
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
 * 按 record_id 批量删除活动时间线（删除 record / 清理全部记录时调用）。
 * 返回实际删除行数。与 append 不同，这里的失败必须上抛：静默失败会留下永久孤儿数据。
 */
async function clearByRecordIds(recordIds: number[]): Promise<number> {
    if (recordIds.length === 0) {
        return 0;
    }
    return await requestActivityManager.deleteByRecordIds(recordIds);
}


/**
 * 找出「指向不存在 record」的活动行（孤儿）并删除，返回删除行数。
 *
 * `request_activity` 无外键、也无 tenant_id：判定孤儿只能靠「record_id 不在现存
 * record id 集合里」。调用方必须先收敛到全局视角（root-only），否则会误删其他租户数据。
 */
async function clearOrphans(existingRecordIds: number[]): Promise<number> {
    const existing = new Set(existingRecordIds);
    const orphanIds = (await requestActivityManager.listRecordIds()).filter(id => !existing.has(id));
    return await requestActivityManager.deleteByRecordIds(orphanIds);
}


export default {
    append,
    getByRecordId,
    clearByRecordIds,
    clearOrphans,
};
