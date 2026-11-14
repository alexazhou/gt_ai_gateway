import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import recordManager from "../manager/recordManager";
import recordService from "../service/recordService";
import configService from "../service/configService";
import { ConfigKey, UserType } from "../constants";
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

// 清理悬空数据（孤儿 payload / activity）root 专用：非 root（含 main 租户 admin）一律 403
//
// 注意用 `c.get("user")?.type` 而不是 `c.get("user_type")` 或 `tenantScope.isSystemAdmin`：
// 1. `/record/*` 已挂 `tenantScopeMiddleware.requireTenantAdmin`，它先注入 `user`，路由上的
//    `authMiddleware.requireAdmin` 看到 `user` 已存在就短路返回，**不会**再 set `user_type`；
// 2. `tenantScope.isSystemAdmin` 会放行 main 租户的 admin，而全局悬空清理必须严格限制为 root。
function assertRoot(c: Context): void {
    const user = c.get("user");
    if (user?.type !== UserType.ROOT) {
        throw new customError.AppError("Root access required", 403);
    }
}

/**
 * 孤儿清理的进度分母：待检查的 payload / activity 总量。
 *
 * 调用方（前端）在开始清理**前**取一次快照作为分母，之后靠累加 step 返回的增量算进度。
 * 不能边删边重新统计：分母会缩水，进度条会往回跳。
 *
 * 为什么 root-only：这两张附属表都没有 tenant_id 列，判定孤儿必须逐条比对全局 record 表，
 * 按某个租户收敛会把其他租户仍存活的 payload 当成孤儿删掉，所以这里不做租户过滤。
 */
async function orphanStats(c: Context) {
    assertRoot(c);
    const stats = await recordService.getOrphanStats();
    return c.json({
        payload_total: stats.payloadTotal,
        activity_total: stats.activityTotal,
        page_size: recordService.CLEAR_ORPHANS_PAGE_SIZE,
        max_page_size: recordService.CLEAR_ORPHANS_MAX_PAGE_SIZE,
    });
}

/**
 * 清理孤儿数据的一片：检查并删除当前游标之后的一页，把新游标返回给调用方。
 *
 * 服务端不保存任何状态（无 run_id、无锁、无进度表）：游标由调用方持有并回传，
 * 计数是**本片增量**，由调用方累加。这样 worker 模式下每个请求都可以落在不同 isolate，
 * 不需要共享内存或落库；代价是进度只存在于调用方页面里。
 */
async function clearOrphansStep(c: Context) {
    assertRoot(c);

    const body = await c.req.json().catch(() => ({})) as {
        after_key?: unknown;
        after_activity_id?: unknown;
        limit?: unknown;
    };

    const limit = parseStepLimit(body.limit);
    const result = await recordService.clearOrphansStep({
        afterKey: parseAfterKey(body.after_key),
        afterActivityId: parseAfterActivityId(body.after_activity_id),
        limit,
    });

    return c.json({
        next_after_key: result.nextAfterKey,
        next_after_activity_id: result.nextAfterActivityId,
        scanned_payloads: result.scannedPayloads,
        deleted_payloads: result.deletedPayloads,
        scanned_activities: result.scannedActivities,
        deleted_activities: result.deletedActivities,
        done: result.done,
    });
}

function parseStepLimit(value: unknown): number {
    if (value === undefined || value === null || value === "") {
        return recordService.CLEAR_ORPHANS_PAGE_SIZE;
    }
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new customError.AppError("limit must be a positive integer", 400);
    }
    return Math.min(limit, recordService.CLEAR_ORPHANS_MAX_PAGE_SIZE);
}

function parseAfterKey(value: unknown): string | null {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (typeof value !== "string") {
        throw new customError.AppError("after_key must be a string", 400);
    }
    return value;
}

function parseAfterActivityId(value: unknown): number | null {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0) {
        throw new customError.AppError("after_activity_id must be a non-negative integer", 400);
    }
    return id;
}

export default {
    listRecords,
    latestRecords,
    getRecord,
    deleteRecord,
    clearPayload,
    clearAll,
    recoverOrphans,
    orphanStats,
    clearOrphansStep,
};
