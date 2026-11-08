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
 * `request_activity` 无外键、也无 tenant_id：判定孤儿只能靠「record_id 不在 record 表里」。
 * 调用方必须先收敛到全局视角（root-only），否则会误删其他租户数据。
 *
 * 边遍历边删，不做全量求差集：按 record_id keyset 分页，每页只判定并删除本页，
 * 内存占用与总行数无关（全量版会把整列 id 常驻内存，行数一多就打爆 worker）。
 *
 * @param pageSize 每页拉取的 record_id 条数
 * @param findExistingRecordIds 判定一批 record_id 里哪些确实还存在（由调用方注入，
 *        避免本 service 反向依赖 recordManager 造成循环引用）
 */
async function clearOrphans(
    pageSize: number,
    findExistingRecordIds: (recordIds: number[]) => Promise<Set<number>>,
): Promise<number> {
    let deleted = 0;
    let lastRecordId: number | null = null;

    while (true) {
        const recordIds = await requestActivityManager.listRecordIdsPage(lastRecordId, pageSize);
        if (recordIds.length === 0) {
            break;
        }
        // 游标推进到本页最后一个 record_id：删除本页孤儿不影响「更大 id」的后续分页
        lastRecordId = recordIds[recordIds.length - 1];

        const existing = await findExistingRecordIds(recordIds);
        const orphanIds = recordIds.filter(id => !existing.has(id));
        if (orphanIds.length > 0) {
            deleted += await requestActivityManager.deleteByRecordIds(orphanIds);
        }
    }

    return deleted;
}


export default {
    append,
    getByRecordId,
    clearByRecordIds,
    clearOrphans,
};
