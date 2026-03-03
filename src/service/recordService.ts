import { SgRecord } from "../model/sgRecord";
import { SgRecordStatus } from "../constants";

async function create(
    userId: number,
    modelId: number,
    requestData: string | null,
) {
    return SgRecord.query().create({
        user_id: userId,
        model_id: modelId,
        request_data: requestData,
        response_data: null,
        status: SgRecordStatus.INIT,
    });
}

async function update(recordId: number, data: Partial<SgRecord>) {
    return SgRecord.query().where("id", recordId).update(data);
}

async function latest(limit: number = 10) {
    return SgRecord.query().orderBy("id", "desc").limit(limit).get();
}

export default {
    create,
    update,
    latest,
};
