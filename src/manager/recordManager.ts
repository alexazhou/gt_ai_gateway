import { SgRecord, RECORD_SUMMARY_COLUMNS } from "../model/sgRecord";
import { SgRecordStatus } from "../constants";

interface RecordListOptions {
    status?: string;
    startTime?: string;
    endTime?: string;
    userIds?: number[] | null;
    modelIds?: number[] | null;
    pageSize: number;
    offset: number;
    summaryOnly?: boolean;
}

interface RecordCreateData {
    user_id: number | null;
    model_id: number | null;
    vendor_id: number | null;
    vendor_model_name: string | null;
    status: SgRecordStatus;
    client_format: string | null;
    upstream_format: string | null;
    first_token_latency: number | null;
    start_at: Date;
    end_at: Date | null;
    cost: number;
}


async function create(data: RecordCreateData) {
    return await SgRecord.query().create(data);
}

/**
 * 更新 record 表字段。response_data 不是 record 表列（存在对象存储），写入表前必须剥离。
 */
async function update(recordId: number, data: Partial<SgRecord>) {
    const { response_data: _omit, ...tableData } = data as any;
    return SgRecord.query().where("id", recordId).update(tableData);
}


async function findById(recordId: number): Promise<SgRecord | null> {
    return await SgRecord.query().find(recordId);
}


async function latest(limit: number = 10, summaryOnly: boolean = false) {
    const q = SgRecord.query().orderBy("id", "desc").limit(limit);
    if (summaryOnly) {
        q.select(RECORD_SUMMARY_COLUMNS);
    }
    return (await q.get()).all();
}


async function list(options: RecordListOptions) {
    const q = SgRecord.query();

    if (options.status) {
        q.where("status", options.status);
    }
    if (options.startTime) {
        q.where("created_at", ">=", options.startTime);
    }
    if (options.endTime) {
        q.where("created_at", "<=", options.endTime);
    }
    if (options.userIds && options.userIds.length > 0) {
        q.whereIn("user_id", options.userIds);
    }
    if (options.modelIds && options.modelIds.length > 0) {
        q.whereIn("model_id", options.modelIds);
    }

    const total = Number(await q.clone().count() || 0);
    const recordsQuery = options.summaryOnly ? q.select(RECORD_SUMMARY_COLUMNS) : q;
    const records = await recordsQuery.orderBy("id", "desc").limit(options.pageSize).offset(options.offset).get();

    return {
        list: records.all(),
        total,
    };
}


async function recent(limit: number) {
    return (await SgRecord.query()
        .orderBy("id", "desc")
        .limit(limit)
        .get()).all();
}


async function deleteById(recordId: number): Promise<boolean> {
    const record = await SgRecord.query().find(recordId);
    if (!record) {
        return false;
    }

    await SgRecord.query().where("id", recordId).delete();
    return true;
}


async function count(): Promise<number> {
    return Number(await SgRecord.query().count() || 0);
}


async function deleteAll(): Promise<void> {
    await SgRecord.query().delete();
}

export default {
    create,
    update,
    findById,
    latest,
    list,
    recent,
    deleteById,
    count,
    deleteAll,
};
