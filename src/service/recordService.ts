import { SgRecord, RECORD_SUMMARY_COLUMNS } from "../model/sgRecord";
import { SgRecordStatus, ApiFormat } from "../constants";
import objectStorageService from "./objectStorageService";
import configService, { ConfigKey } from "./configService";

interface RecordPayload {
    request: string | null;
    response: string | null;
}

function isLogEnabled(): boolean {
    return process.env.RECORD_LOG_ENABLED === "true";
}

async function isPayloadRecordingEnabled(): Promise<boolean> {
    return (await configService.getConfig(ConfigKey.RECORD_PAYLOAD_ENABLED)).getBoolean();
}

function storageKey(recordId: number): string {
    return `record/${recordId}`;
}

async function readPayload(recordId: number): Promise<RecordPayload> {
    const raw = await objectStorageService.getText(storageKey(recordId));
    if (!raw) {
        return { request: null, response: null };
    }
    try {
        const parsed = JSON.parse(raw) as Partial<RecordPayload>;
        return {
            request: parsed.request ?? null,
            response: parsed.response ?? null,
        };
    } catch (e) {
        console.error(`[RecordService] Failed to parse stored payload for record ${recordId}:`, e);
        return { request: null, response: null };
    }
}

async function writePayload(recordId: number, payload: RecordPayload): Promise<void> {
    await objectStorageService.putText(storageKey(recordId), JSON.stringify(payload));
}

async function attachPayload(record: SgRecord): Promise<SgRecord> {
    const payload = await readPayload(Number(record.id));
    record.request_data = payload.request;
    record.response_data = payload.response;
    return record;
}

async function create(
    userId: number,
    modelId: number | null,
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

    const record = await SgRecord.query().create({
        user_id: userId,
        model_id: modelId,
        vendor_id: vendorId,
        vendor_model_name: vendorModelName,
        status: SgRecordStatus.INIT,
        client_format: clientFormat,
        upstream_format: upstreamFormat !== clientFormat ? upstreamFormat : null,
        first_token_latency: null,
        start_at: null,
        end_at: null,
        cost: 0,
    });

    if (await isPayloadRecordingEnabled()) {
        await writePayload(Number(record.id), {
            request: requestData ?? null,
            response: null,
        });
    }

    return record;
}

async function update(recordId: number, data: Partial<SgRecord>) {
    if (isLogEnabled()) {
        console.log(`[RecordService] Updating record ${recordId}:`, JSON.stringify(data, null, 2));
    }

    if (Object.prototype.hasOwnProperty.call(data, "response_data")) {
        if (await isPayloadRecordingEnabled()) {
            const payload = await readPayload(recordId);
            payload.response = (data as any).response_data ?? null;
            await writePayload(recordId, payload);
        }

        // response_data is never a record-table column (it lives in object storage),
        // so it must always be stripped before updating the table.
        const { response_data: _omit, ...tableData } = data as any;
        return SgRecord.query().where("id", recordId).update(tableData);
    }

    return SgRecord.query().where("id", recordId).update(data);
}

async function latest(limit: number = 10, summaryOnly: boolean = false) {
    const q = SgRecord.query().orderBy("id", "desc").limit(limit);
    if (summaryOnly) {
        q.select(RECORD_SUMMARY_COLUMNS);
    }
    const records = await q.get();

    if (!summaryOnly) {
        await Promise.all(records.map((r: SgRecord) => attachPayload(r)));
    }
    return records;
}

async function recordFailedRequest(
    userId: number,
    modelName: string | null,
    body: string,
    clientFormat: ApiFormat,
    failedCode: string,
    modelId: number | null = null,
    vendorId: number | null = null
) {
    try {
        const record = await create(
            userId,
            modelId,
            body,
            clientFormat,
            null,
            vendorId,
            modelName
        );
        await update(record.id, {
            status: SgRecordStatus.FAILED,
            failed_code: failedCode,
            end_at: new Date(),
        });
    } catch (e) {
        console.error("Failed to write failed record:", e);
    }
}

export default {
    create,
    update,
    latest,
    recordFailedRequest,
    attachPayload,
};
