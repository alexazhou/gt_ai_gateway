import { SgRequestActivity } from "../model/sgRequestActivity";

// whereIn 的分批大小：SQLite 单条语句的绑定变量数有上限（旧版 999），
// 一次删上万条 record 时必须分批，否则会直接报 too many SQL variables
const DELETE_BATCH_SIZE = 500;

async function findByRecordId(recordId: number): Promise<SgRequestActivity | null> {
    return await SgRequestActivity.query().where("record_id", recordId).first();
}

async function updateActivities(recordId: number, activitiesJson: string): Promise<void> {
    await SgRequestActivity.query().where("record_id", recordId).update({
        activities: activitiesJson,
    });
}

async function createActivity(recordId: number, activitiesJson: string): Promise<void> {
    await SgRequestActivity.query().create({
        record_id: recordId,
        activities: activitiesJson,
    });
}

/**
 * 按 record_id 批量删除活动时间线。
 *
 * request_activity 与 record 只是逻辑关联（无外键级联），删除 record 时必须显式清理，
 * 否则整行 JSON 时间线会永久留在库里。返回实际删除行数（调用方用于回报）。
 */
async function deleteByRecordIds(recordIds: number[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < recordIds.length; i += DELETE_BATCH_SIZE) {
        const batch = recordIds.slice(i, i + DELETE_BATCH_SIZE);
        const affected = await SgRequestActivity.query().whereIn("record_id", batch).delete();
        deleted += Number(affected || 0);
    }
    return deleted;
}

/**
 * 列出表中全部 record_id（只取该列，不加载 activities JSON）。
 * 孤儿清理用：与 record 表 id 集合求差集，得到「指向已删记录」的行。
 */
async function listRecordIds(): Promise<number[]> {
    const rows = await SgRequestActivity.query().select("record_id").get();
    return rows.all().map(r => Number(r.record_id));
}

export default {
    findByRecordId,
    updateActivities,
    createActivity,
    deleteByRecordIds,
    listRecordIds,
};
