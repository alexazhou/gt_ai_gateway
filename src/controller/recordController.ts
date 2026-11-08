import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import recordManager from "../manager/recordManager";
import recordService from "../service/recordService";
import configService from "../service/configService";
import { ConfigKey } from "../constants";
import { parsePaginationQuery } from "../util/paginationUtil";
import customError from "../customError";

function normalizeTimestampField(value: unknown): string | number | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    return value as string | number;
}

interface RecordWithAttributes {
    getAttributes?: () => Record<string, unknown>;
}

function serializeRecord(record: SgRecord) {
    const data = record.toData();
    const rawAttributes = (record as unknown as RecordWithAttributes).getAttributes?.();

    return {
        ...data,
        start_at: normalizeTimestampField(rawAttributes?.start_at ?? data.start_at),
        end_at: normalizeTimestampField(rawAttributes?.end_at ?? data.end_at),
    };
}

async function listRecords(c: Context) {
    const scope = c.get("tenantScope")!;
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const { status, start_time, end_time } = query;

    // user_ids 和 model_ids 支持多选，格式为逗号分隔的 ID 列表
    const userIds = query.user_ids ? query.user_ids.split(",").map(Number).filter(Boolean) : null;
    const modelIds = query.model_ids ? query.model_ids.split(",").map(Number).filter(Boolean) : null;

    const { list: records, total } = await recordManager.list({
        status,
        startTime: start_time,
        endTime: end_time,
        userIds,
        modelIds,
        pageSize,
        offset,
        summaryOnly: true,
    }, scope.tenantId);

    return c.json({
        list: records.map(serializeRecord),
        total,
    });
}

async function latestRecords(c: Context) {
    const scope = c.get("tenantScope")!;
    const query = c.req.query();
    const { pageSize } = parsePaginationQuery(query, 10);
    const records = await recordService.latest(pageSize, false, scope.tenantId);
    return c.json(records.map(serializeRecord));
}

async function getRecord(c: Context) {
    const scope = c.get("tenantScope")!;
    const id = c.req.param("id");
    const recordId = parseInt(id, 10);
    console.log("id", id, "recordId", recordId);

    if (isNaN(recordId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const record = await recordManager.findByIdInTenant(recordId, scope.tenantId);

    if (!record) {
        return c.json({ error: "Record not found" }, 404);
    }

    await recordService.attachPayload(record);

    return c.json(serializeRecord(record));
}

async function deleteRecord(c: Context) {
    const scope = c.get("tenantScope")!;
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) {
        return c.json({ error: "Invalid ID" }, 400);
    }

    // 级联删除：record + payload + request_activity（只删 record 会留下孤儿数据）
    const deleted = await recordService.deleteOne(id, scope.tenantId);
    if (!deleted) {
        return c.json({ error: "Record not found" }, 404);
    }

    return c.json({ success: true });
}

async function clearPayload(c: Context) {
    const scope = c.get("tenantScope")!;
    const cleared = await recordService.clearPayloads(scope.tenantId);
    return c.json({ success: true, cleared });
}

async function clearAll(c: Context) {
    const scope = c.get("tenantScope")!;
    // 级联清理 payload + activity + record；只删 record 会让数据库几乎不缩小
    const result = await recordService.clearAll(scope.tenantId);
    return c.json({
        success: true,
        deleted: result.deleted,
        cleared_payloads: result.clearedPayloads,
        deleted_activities: result.deletedActivities,
    });
}

async function recoverOrphans(c: Context) {
    const scope = c.get("tenantScope")!;
    const thresholdMs = await configService.getNumber(ConfigKey.ORPHAN_RECOVER_THRESHOLD_MS);
    // getNumber() 对未配置/非法值返回 0，回退默认阈值 10 分钟
    const recovered = await recordManager.recoverOrphans(thresholdMs > 0 ? thresholdMs : 600000, scope.tenantId);
    return c.json({ success: true, recovered });
}

// 清理悬空数据（孤儿 payload / activity）root 专用：非 root 一律 403
//
// 注意用 `tenantScope.isRoot` 而不是 `c.get("user_type")`：`/record/*` 已挂
// `tenantScopeMiddleware.requireTenantAdmin`，它先注入 `user`，路由上的
// `authMiddleware.requireAdmin` 看到 `user` 已存在就短路返回，**不会**再 set `user_type`。
// 用 `user_type` 判断在 /record 下恒为 undefined，会把 root 一起挡掉。
function assertRoot(c: Context): void {
    const scope = c.get("tenantScope");
    if (!scope?.isRoot) {
        throw new customError.AppError("Root access required", 403);
    }
}

/**
 * 清理孤儿数据：record 已不存在、原文（storage_record / R2）与活动时间线还留着的存量。
 *
 * 为什么 root-only：这两张附属表都没有 tenant_id 列，判定孤儿必须用「现存 record id 全集合」，
 * 按某个租户收敛会把其他租户仍存活的 payload 当成孤儿删掉，所以这里不做租户过滤。
 */
async function clearOrphans(c: Context) {
    assertRoot(c);
    const result = await recordService.clearOrphans();
    return c.json({
        success: true,
        cleared_payloads: result.clearedPayloads,
        deleted_activities: result.deletedActivities,
    });
}

export default {
    listRecords,
    latestRecords,
    getRecord,
    deleteRecord,
    clearPayload,
    clearAll,
    recoverOrphans,
    clearOrphans,
};
