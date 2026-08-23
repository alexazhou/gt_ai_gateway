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
            payload.response = (data as any).response_data ?? null;
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
};
