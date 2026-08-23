import { SgRecord, RECORD_SUMMARY_COLUMNS } from "../model/sgRecord";
import { SgRecordStatus, FailedCode, RequestActivityStage, ActivityLevel } from "../constants";
import billingUtil from "../util/protocol/billingUtil";
import requestActivityService from "../service/requestActivityService";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";

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
    tenant_id?: number | null;
}

/**
 * record 表更新载荷。usage 列以「存储串」写入（DB 值），与模型读侧的 SgRecordUsage 实例不同表示；
 * response_data 不是 record 表列（存在对象存储），update 时会被剥离。
 */
type RecordUpdateData = Partial<Omit<SgRecord, "usage">> & {
    usage?: string | null;
};


async function create(data: RecordCreateData) {
    return await SgRecord.query().create({
        ...data,
        tenant_id: data.tenant_id ?? null,
    });
}

/**
 * 更新 record 表字段。response_data 不是 record 表列（存在对象存储），写入表前必须剥离。
 * cost 以"元"传入；裸 query().update() 不走模型 cast，这里手动换算成整数微元存储；
 * usage 同样直接以存储串写入（见 RecordUpdateData）。
 */
async function update(recordId: number, data: RecordUpdateData) {
    const { response_data: _omit, ...tableData } = data as any;
    if (tableData.cost !== undefined) {
        tableData.cost = billingUtil.toUnits(tableData.cost);
    }
    return SgRecord.query().where("id", recordId).update(tableData);
}


async function findById(recordId: number): Promise<SgRecord | null> {
    return await SgRecord.query().find(recordId);
}


async function findByIdInTenant(recordId: number, tenantId: number): Promise<SgRecord | null> {
    return await SgRecord.query().where("id", recordId).where("tenant_id", tenantId).first();
}


async function latest(limit: number = 10, summaryOnly: boolean = false, tenantId?: number) {
    const q = SgRecord.query().orderBy("id", "desc").limit(limit);
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    if (summaryOnly) {
        q.select(RECORD_SUMMARY_COLUMNS);
    }
    return (await q.get()).all();
}


async function list(options: RecordListOptions, tenantId?: number) {
    const q = SgRecord.query();

    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }

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


async function recent(limit: number, tenantId?: number) {
    const q = SgRecord.query();
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    return (await q.orderBy("id", "desc").limit(limit).get()).all();
}


async function deleteById(recordId: number, tenantId?: number): Promise<boolean> {
    const q = SgRecord.query();
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    const record = await q.where("id", recordId).first();
    if (!record) {
        return false;
    }

    await SgRecord.query().where("id", recordId).delete();
    return true;
}


async function count(tenantId?: number): Promise<number> {
    const q = SgRecord.query();
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    return Number(await q.count() || 0);
}


async function deleteAll(tenantId?: number): Promise<void> {
    const q = SgRecord.query();
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    await q.delete();
}


/** 按租户取 record id 列表（clear-payload 按租户删除对象存储 key 用） */
async function listIdsByTenant(tenantId: number): Promise<number[]> {
    const rows = await SgRecord.query().select("id").where("tenant_id", tenantId).get();
    return rows.all().map(r => Number(r.id));
}


/**
 * 把 Date 格式化成 record.start_at 的存储格式（本地时区 'YYYY-MM-DD HH:mm:ss'）。
 * start_at 经 model datetime cast（dayjs local）写入该格式；raw query 绑定 Date 会存成 epoch 毫秒，
 * 两者混比会因 SQLite TEXT/NUMERIC 排序规则失真，因此查询必须用同格式字符串比较。
 */
function formatDbDatetime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}


/**
 * 回收孤儿记录（手动触发）：把「长期未结束」的记录（status 为 init/processing 且 end_at 为空、
 * start_at 距现在超过 thresholdMs）统一标 FAILED + recovered_orphan，并追加 RESULT 活动。
 * 返回回收条数。
 */
async function recoverOrphans(thresholdMs: number, tenantId?: number): Promise<number> {
    const cutoff = formatDbDatetime(new Date(Date.now() - thresholdMs));
    const q = SgRecord.query()
        .whereIn("status", [SgRecordStatus.INIT, SgRecordStatus.PROCESSING])
        .whereNull("end_at")
        .where("start_at", "<", cutoff);
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    const orphans = await q.get();
    const rows = orphans.all();

    for (const row of rows) {
        await update(Number(row.id), {
            status: SgRecordStatus.FAILED,
            failed_code: FailedCode.RECOVERED_ORPHAN,
            end_at: new Date(),
        });
        await requestActivityService.append(Number(row.id), RequestActivityStage.RESULT, "孤儿记录回收", {
            status: SgRecordStatus.FAILED,
            failed_code: FailedCode.RECOVERED_ORPHAN,
        }, ActivityLevel.WARN);
    }
    return rows.length;
}

export { RecordUpdateData };


export default {
    create,
    update,
    findById,
    findByIdInTenant,
    latest,
    list,
    recent,
    listIdsByTenant,
    deleteById,
    count,
    deleteAll,
    recoverOrphans,
};
