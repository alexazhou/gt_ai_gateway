import { SgRecord } from "../model/sgRecord";
import { SgRecordStatus, ApiFormat, ConfigKey, RequestActivityStage, ActivityLevel } from "../constants";
import recordManager, { type RecordUpdateData } from "../manager/recordManager";
import objectStorageService from "./objectStorageService";
import configService from "./configService";
import requestActivityService from "./requestActivityService";

interface RecordPayload {
    request: string | null;
    response: string | null;
}

const RECORD_PAYLOAD_PREFIX = "record/";

function isLogEnabled(): boolean {
    return process.env.RECORD_LOG_ENABLED === "true";
}

async function isPayloadRecordingEnabled(): Promise<boolean> {
    return (await configService.getConfig(ConfigKey.RECORD_PAYLOAD_ENABLED)).getBoolean();
}

function storageKey(recordId: number): string {
    return `${RECORD_PAYLOAD_PREFIX}${recordId}`;
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

/** 按租户清空 payload：先查该租户 record id 列表再逐个删 key（recordId 全局唯一，天然无跨租户冲突） */
async function clearPayloads(tenantId?: number): Promise<number> {
    if (tenantId === undefined) {
        return objectStorageService.deleteByPrefix(RECORD_PAYLOAD_PREFIX);
    }
    const ids = await recordManager.listIdsByTenant(tenantId);
    let cleared = 0;
    for (const id of ids) {
        await objectStorageService.delete(storageKey(id));
        cleared += 1;
    }
    return cleared;
}

export interface ClearRecordsResult {
    /** 删除的 record 行数（对外回报用，与旧接口的 deleted 语义一致） */
    deleted: number;
    /** 清理的 payload 条数（请求/响应原文，storage_record 或 R2） */
    clearedPayloads: number;
    /** 清理的活动时间线行数（request_activity） */
    deletedActivities: number;
}

/**
 * 删除一条记录及其全部附属数据。
 *
 * 顺序固定：payload → activity → record。
 * - payload / activity 都是无外键的逻辑关联，漏删就是永久孤儿数据（曾导致「删了但磁盘不降」）；
 * - record 最后删：中途失败时记录仍在，用户能看见并重试，不会出现「查不到却占空间」的残留。
 */
async function deleteOne(recordId: number, tenantId?: number): Promise<boolean> {
    const record = tenantId === undefined
        ? await recordManager.findById(recordId)
        : await recordManager.findByIdInTenant(recordId, tenantId);
    if (!record) {
        return false;
    }

    await objectStorageService.delete(storageKey(recordId));
    await requestActivityService.clearByRecordIds([recordId]);
    await recordManager.deleteById(recordId, tenantId);
    return true;
}

/**
 * 删除某个租户的全部记录及其附属数据（「删除完整请求记录」的实际实现）。
 *
 * 旧实现只删 record 一张表，storage_record 与 request_activity 全部残留，
 * 是「点了删除但数据库不缩小」的根因；这里按 payload → activity → record 的顺序级联清理。
 *
 * `tenantId` 必填：request_activity 没有 tenant_id 列，租户维度只能靠 record id 列表收敛，
 * 一旦允许「不传租户」就会退化成整表清空（跨租户误删），故不提供该分支。
 */
async function clearAll(tenantId: number): Promise<ClearRecordsResult> {
    const deleted = await recordManager.count(tenantId);
    // 先取一次 id 列表，payload 与 activity 共用，避免重复查库
    const tenantRecordIds = await recordManager.listIdsByTenant(tenantId);

    // ① payload：按 id 列表逐个删，避免误删其他租户的原文
    let clearedPayloads = 0;
    for (const id of tenantRecordIds) {
        await objectStorageService.delete(storageKey(id));
        clearedPayloads += 1;
    }

    // ② activity：按该租户的 record id 批量删
    const deletedActivities = await requestActivityService.clearByRecordIds(tenantRecordIds);

    // ③ 最后删 record 本体
    await recordManager.deleteAll(tenantId);

    return { deleted, clearedPayloads, deletedActivities };
}

export interface ClearOrphansResult {
    /** 删除的 payload 条数（record 已不存在、原文还留在 storage_record / R2 里） */
    clearedPayloads: number;
    /** 删除的活动时间线行数（record_id 指向已不存在的 record） */
    deletedActivities: number;
}

/**
 * 清理孤儿数据（root-only 全局清理）。
 *
 * 两类孤儿：
 * - **payload 孤儿**：`storage_record.object_key` 形如 `record/{id}`，但 `record` 表里已无该 id
 *   （旧版删除只删 record 行、不删原文留下的存量）；
 * - **activity 孤儿**：`request_activity.record_id` 不在 `record` 表里。
 *
 * ⚠️ **必须全局视角**：这两张表都没有 tenant_id，只有「现存 record id 全集合」才能判定孤儿。
 * 若按某个租户收敛，该租户视角之外的存活 payload 会被当成孤儿删掉。故本函数不做租户过滤，
 * 由调用方（controller）保证只有 root 能触发。
 *
 * 存量清理与「以后不再产生」是两件事：级联删除的修复只保证后者，历史上已经留下的孤儿靠这里清。
 */
async function clearOrphans(): Promise<ClearOrphansResult> {
    const existingRecordIds = await recordManager.listAllIds();
    const existing = new Set(existingRecordIds);

    // ① payload：key 形如 record/{id}，id 不在现存集合里即孤儿
    const orphanPayloadKeys: string[] = [];
    for (const key of await objectStorageService.listKeysByPrefix(RECORD_PAYLOAD_PREFIX)) {
        const rawId = key.slice(RECORD_PAYLOAD_PREFIX.length);
        const id = Number(rawId);
        // 只处理形如 record/<整数> 的 key：前缀下若有别的命名（未来扩展）一律不动，宁可漏删不误删
        if (!rawId || !Number.isInteger(id) || String(id) !== rawId) {
            continue;
        }
        if (!existing.has(id)) {
            orphanPayloadKeys.push(key);
        }
    }
    const clearedPayloads = await objectStorageService.deleteMany(orphanPayloadKeys);

    // ② activity：record_id 不在现存集合里即孤儿
    const deletedActivities = await requestActivityService.clearOrphans(existingRecordIds);

    return { clearedPayloads, deletedActivities };
}

// 一条用户请求 = 一条 record：进入路由循环前创建，此时还不知道命中的上游
// 上游信息（vendor_id / vendor_model_name / upstream_format）由后续每次上游尝试 update 覆盖
async function create(
    userId: number,
    modelId: number | null,
    requestData: string | null,
    clientFormat: string | null = null,
    tenantId?: number,
) {
    if (isLogEnabled()) {
        console.log(`[RecordService] Creating record: user=${userId}, model=${modelId}`);
        if (requestData) {
            console.log(`[RecordService] Request data: ${requestData}`);
        }
    }

    const record = await recordManager.create({
        user_id: userId,
        model_id: modelId,
        vendor_id: null,
        vendor_model_name: null,
        status: SgRecordStatus.INIT,
        client_format: clientFormat,
        upstream_format: null,
        first_token_latency: null,
        start_at: new Date(),
        end_at: null,
        cost: 0,
        tenant_id: tenantId ?? null,
    });

    if (await isPayloadRecordingEnabled()) {
        await writePayload(Number(record.id), {
            request: requestData ?? null,
            response: null,
        });
    }

    return record;
}

async function update(recordId: number, data: RecordUpdateData) {
    if (isLogEnabled()) {
        console.log(`[RecordService] Updating record ${recordId}:`, JSON.stringify(data, null, 2));
    }

    // response_data 存在对象存储，写入表前先落存储
    if (Object.prototype.hasOwnProperty.call(data, "response_data")) {
        if (await isPayloadRecordingEnabled()) {
            const payload = await readPayload(recordId);
            payload.response = data.response_data ?? null;
            await writePayload(recordId, payload);
        }
    }

    return recordManager.update(recordId, data);
}

async function latest(limit: number = 10, summaryOnly: boolean = false, tenantId?: number) {
    const records = await recordManager.latest(limit, summaryOnly, tenantId);

    if (!summaryOnly) {
        await Promise.all(records.map((r: SgRecord) => attachPayload(r)));
    }
    return records;
}

export interface MarkFailedOptions {
    /** 活动文案；省略时默认用 failed_code 本身（中文标签由前端 FAILED_CODE_LABELS 映射） */
    message?: string;
    /** 活动 stage，默认 result */
    stage?: RequestActivityStage;
    /** 活动级别，默认 warn */
    level?: ActivityLevel;
    /** 追加到活动 detail 的额外字段 */
    detail?: Record<string, unknown>;
    /** 同时写入 response_data（存在对象存储） */
    response_data?: string | null;
}

/**
 * 统一「把 record 标为失败」的收尾：更新 FAILED + failed_code + end_at，并追加一条 RESULT 活动。
 * 供各失败路径（上游超时/断连、非成功响应等）复用，避免 update + append 两步重复。
 * options 传 null 表示无附加参数；message 省略时默认用 failed_code 本身作为活动文案。
 */
async function markFailed(
    recordId: number,
    failedCode: string | null,
    options: MarkFailedOptions | null = null,
): Promise<void> {
    const opts = options ?? {};

    const updateData: RecordUpdateData = {
        status: SgRecordStatus.FAILED,
        failed_code: failedCode,
        end_at: new Date(),
    };
    if (opts.response_data !== undefined) {
        // 报错文案由调用方从错误对象提取，这里不按失败码生成文案
        updateData.response_data = opts.response_data;
    }
    await update(recordId, updateData);

    const label = opts.message ?? failedCode ?? "请求失败";

    await requestActivityService.append(
        recordId,
        opts.stage ?? RequestActivityStage.RESULT,
        label,
        {
            status: SgRecordStatus.FAILED,
            ...(failedCode !== null ? { failed_code: failedCode } : {}),
            ...opts.detail,
        },
        opts.level ?? ActivityLevel.ERROR,
    );
}

/**
 * 记一条失败记录（创建 + 标记 FAILED + 追加 RESULT 活动）。
 * 与 markFailed 一致会写活动日志，保证失败时间线可追溯（如阶段一规则拒绝 403/429）。
 * message 省略时默认用 failedCode 本身作为活动文案。
 */
async function recordFailedRequest(
    userId: number,
    modelName: string | null,
    body: string,
    clientFormat: ApiFormat,
    failedCode: string,
    modelId: number | null = null,
    message?: string,
    detail?: Record<string, unknown>,
    tenantId?: number,
) {
    try {
        const record = await create(
            userId,
            modelId,
            body,
            clientFormat,
            tenantId,
        );
        await markFailed(record.id, failedCode, {
            message: message ?? failedCode,
            ...(detail ? { detail } : {}),
        });
    } catch (e) {
        console.error("Failed to write failed record:", e);
    }
}

export default {
    create,
    update,
    latest,
    markFailed,
    recordFailedRequest,
    attachPayload,
    clearPayloads,
    deleteOne,
    clearAll,
    clearOrphans,
};
