import { SgRequestActivity } from "../model/sgRequestActivity";

async function findByRecordId(recordId: number): Promise<SgRequestActivity | null> {
    return await SgRequestActivity.query().where("record_id", recordId).first();
}

/** 批量查活动行（P2-27：孤儿回收按页批量读，避免逐条往返） */
async function findByRecordIds(recordIds: number[]): Promise<SgRequestActivity[]> {
    if (recordIds.length === 0) {
        return [];
    }
    const rows = await SgRequestActivity.query().whereIn("record_id", recordIds).get();
    return rows.all();
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

export default {
    findByRecordId,
    findByRecordIds,
    updateActivities,
    createActivity,
};
