import { SgRecord } from "../model/sgRecord";
import { SgRecordStatus } from "../constants";

function isLogEnabled(): boolean {
    return process.env.RECORD_LOG_ENABLED === "true";
}

async function create(
    userId: number,
    modelId: number,
    requestData: string | null,
    clientFormat: string | null = null,
    upstreamFormat: string | null = null,
    vendorId: number | null = null,
    vendorModelName: string | null = null,
) {
    if (isLogEnabled()) {
        console.log(`[RecordService] Creating record: user=${userId}, model=${modelId}`);
        if (requestData) {
            console.log(`[RecordService] Request data: ${requestData}`);
        }
    }

    return SgRecord.query().create({
        user_id: userId,
        model_id: modelId,
        vendor_id: vendorId,
        vendor_model_name: vendorModelName,
        request_data: requestData,
        response_data: null,
        status: SgRecordStatus.INIT,
        client_format: clientFormat,
        upstream_format: upstreamFormat !== clientFormat ? upstreamFormat : null,
        first_token_latency: null,
        start_at: null,
        end_at: null,
        cost: 0,
    });
}

async function update(recordId: number, data: Partial<SgRecord>) {
    if (isLogEnabled()) {
        console.log(`[RecordService] Updating record ${recordId}:`, JSON.stringify(data, null, 2));
    }

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
