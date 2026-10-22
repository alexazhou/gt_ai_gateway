import { SgRecord, RECORD_SUMMARY_COLUMNS } from "../model/sgRecord";
import { SgRecordStatus, FailedCode, RequestActivityStage, ActivityLevel } from "../constants";
import billingUtil from "../util/protocolUtil/billingUtil";
import requestActivityService from "../service/requestActivityService";
import ormService from "../service/ormService";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";
import type { SqlStatement } from "../util/dbAdapterUtil";

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
    const { response_data: _omit, ...tableData } = data;
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
export function formatDbDatetime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}


/**
 * 回收孤儿记录（手动触发）：把「长期未结束」的记录（status 为 init/processing 且 end_at 为空、
 * start_at 距现在超过 thresholdMs）统一标 FAILED + recovered_orphan，并追加 RESULT 活动。
 * 返回回收条数。
 */
// 单批回收条数（分页大小）：决定一次查多少行，与「一条 SQL 能带多少个 id」是两件事
// （后者见 RECOVER_ORPHAN_BIND_BUDGET / resolveRecoverOrphanIdChunk，P2-27）
const RECOVER_ORPHAN_BATCH = 200;

/**
 * 单条 SQL 的绑定变量预算（P2-27）。
 *
 * **D1 单语句的绑定变量上限是 100**，超过即 `D1_ERROR: too many SQL variables`；
 * 而 SQLite 是 999、MySQL 更高，所以把分页大小直接塞进一条 `WHERE id IN (...)` 时，
 * node 侧一直绿、worker 侧整个接口 500。这里取 90（留 10 个余量给以后可能新增的赋值参数），
 * **不要按 node 的上限或分页大小 200 来定这个值**。
 */
const RECOVER_ORPHAN_BIND_BUDGET = 90;


/**
 * 由「SET 子句的赋值参数个数」算出单条 UPDATE 最多能带多少个 id（P2-27）。
 *
 * 运行时算而不是写死 87：以后给 SET 子句加一个字段（比如 recovered_at），
 * 片大小会自动收窄；写死的话「常量不同步」就会再次超限，且只在 worker 大数据量下才炸。
 * 预算不足（SET 参数本身就 ≥ 90）直接抛，属于编码错误，早失败比线上 500 好。
 */
export function resolveRecoverOrphanIdChunk(setParamCount: number): number {
    const chunk = RECOVER_ORPHAN_BIND_BUDGET - setParamCount;
    if (chunk <= 0) {
        throw new Error(
            `RECOVER_ORPHAN 绑定变量预算不足：SET 参数 ${setParamCount} 个，预算 ${RECOVER_ORPHAN_BIND_BUDGET}`,
        );
    }
    return chunk;
}


/**
 * 单次 batch 提交包含多少条语句。
 * D1 的 `batch()` 一次算一次 subrequest，但一批语句太多也不健康（内存/超时），
 * 50 条一批在「往返次数」与「单批体积」之间取平衡（P2-27）。
 */
const RECOVER_ORPHAN_STATEMENTS_PER_BATCH = 50;


/**
 * 分批原子提交语句：批内原子（D1 batch / sqlite transaction / mysql 事务），批间顺序执行。
 * 用于「几百条记录一起收尾」这类会撞 D1 subrequest 配额的场景（P2-27）。
 */
async function runInStatementBatches(statements: SqlStatement[]): Promise<void> {
    for (let i = 0; i < statements.length; i += RECOVER_ORPHAN_STATEMENTS_PER_BATCH) {
        await ormService.runAtomically(statements.slice(i, i + RECOVER_ORPHAN_STATEMENTS_PER_BATCH));
    }
}


/** 按步长把 id 列表切段（构造 IN (...) 时单语句绑定变量不能超预算） */
function chunkIds(ids: number[], size: number): number[][] {
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += size) {
        chunks.push(ids.slice(i, i + size));
    }
    return chunks;
}


/**
 * 回收孤儿记录（P2-10）。
 *
 * 原实现是「一次查全 + 逐行 update + 逐行 append 活动」，每行 2 次写：
 * 孤儿多的时候（比如一次 Worker 重启留下几百条 processing）等于几百轮串行往返，
 * 既慢又容易在 D1 上触发写限流。现在改为「分页查 + 单条批量 UPDATE + 活动并行写」。
 */
async function recoverOrphans(thresholdMs: number, tenantId?: number): Promise<number> {
    const cutoff = formatDbDatetime(new Date(Date.now() - thresholdMs));
    const seen = new Set<number>();
    let recovered = 0;

    for (;;) {
        const q = SgRecord.query()
            .whereIn("status", [SgRecordStatus.INIT, SgRecordStatus.PROCESSING])
            .whereNull("end_at")
            .where("start_at", "<", cutoff)
            .limit(RECOVER_ORPHAN_BATCH);
        if (tenantId !== undefined) {
            q.where("tenant_id", tenantId);
        }
        const rows = (await q.get()).all();

        // 过滤掉本函数已经处理过的 id：UPDATE 若因并发/事务可见性没生效，也不会死循环
        const ids: number[] = [];
        for (const row of rows) {
            const id = Number(row.id);
            if (!seen.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        }
        if (ids.length === 0) {
            break;
        }

        // 记录更新 + 活动写入合成一批语句（P2-27）。
        //
        // 两处都必须批量化，否则在 Worker 下会撞两个不同的墙：
        // ① 记录更新：一页 200 个 id 拼成一条 `WHERE id IN (...)` 是 203 个绑定变量，
        //    超过 D1 的 100 上限（node 的 sqlite 上限 999，所以 node 侧看不出来）→ 分片；
        //    片大小 = 预算 90 - SET 参数个数（当前 3 个 → 87），由 resolveRecoverOrphanIdChunk 现算；
        // ② 活动日志：原来是逐条 append（每条 3 次往返），250 条 = 750 次 D1 往返，
        //    直接打爆 Worker 的 subrequest 配额 —— 客户端看到的不是报错而是连接被重置（ECONNRESET）。
        //    改为「分片批量读 + 内存拼 JSON + 分批 UPSERT」。
        //
        // 分片后仍是同一批语义：同一批 id 的更新在一批里原子提交、`WHERE id IN (...)` /
        // `ON CONFLICT(record_id)` 天然幂等（重复执行只写入同样的值），一条记录只会被回收一次。
        const now = formatDbDatetime(new Date());

        // SET 子句由对象生成：占位符与参数同源，加字段时不会出现「参数加了、片大小没跟着改」
        const assignments: Record<string, unknown> = {
            status: SgRecordStatus.FAILED,
            failed_code: FailedCode.RECOVERED_ORPHAN,
            end_at: now,
        };
        const setClause = Object.keys(assignments).map((column) => `${column} = ?`).join(", ");
        const setParams = Object.values(assignments);
        const idChunkSize = resolveRecoverOrphanIdChunk(setParams.length);

        const updateStatements: SqlStatement[] = chunkIds(ids, idChunkSize).map((idChunk) => ({
            sql: `UPDATE record SET ${setClause} WHERE id IN (${idChunk.map(() => "?").join(", ")})`,
            params: [...setParams, ...idChunk],
        }));

        await runInStatementBatches(updateStatements);

        // 活动日志是读改写的 JSON 列，无法只靠 SQL 追加；保持原来的 best-effort 语义
        // （活动写失败不能让已经回收成功的记录回滚/丢回收），所以单独一批并吞掉异常，
        // 但必须留下可发现的日志（P2-11 的教训：静默 catch 等于假装兜底）
        try {
            const activityStatements = await requestActivityService.buildAppendedStatements(
                ids,
                {
                    stage: RequestActivityStage.RESULT,
                    message: "孤儿记录回收",
                    details: { status: SgRecordStatus.FAILED, failed_code: FailedCode.RECOVERED_ORPHAN },
                    level: ActivityLevel.WARN,
                },
                now,
            );
            await runInStatementBatches(activityStatements);
        } catch (e) {
            console.warn("[recordManager] 孤儿回收活动日志写入失败（记录已回收）:", {
                count: ids.length,
                firstRecordId: ids[0],
                error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
            });
        }

        recovered += ids.length;
        if (rows.length < RECOVER_ORPHAN_BATCH) {
            break;
        }
    }

    return recovered;
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
