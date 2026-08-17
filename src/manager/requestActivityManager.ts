import { SgRequestActivity } from "../model/sgRequestActivity";

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

export default {
    findByRecordId,
    updateActivities,
    createActivity,
};
