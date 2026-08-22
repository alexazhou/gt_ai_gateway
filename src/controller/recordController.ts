import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import recordManager from "../manager/recordManager";
import recordService from "../service/recordService";
import configService from "../service/configService";
import { ConfigKey } from "../constants";
import { parsePaginationQuery } from "../util/paginationUtil";

function normalizeTimestampField(value: unknown): string | number | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    return value as string | number;
}

function serializeRecord(record: SgRecord) {
    const data = record.toData() as Record<string, unknown>;
    const rawAttributes = (record as any).getAttributes?.() as Record<string, unknown> | undefined;

    return {
        ...data,
        start_at: normalizeTimestampField(rawAttributes?.start_at ?? data.start_at),
        end_at: normalizeTimestampField(rawAttributes?.end_at ?? data.end_at),
    };
}

async function listRecords(c: Context) {
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
    });

    return c.json({
        list: records.map(serializeRecord),
        total,
    });
}

async function latestRecords(c: Context) {
    const query = c.req.query();
    const { pageSize } = parsePaginationQuery(query, 10);
    const records = await recordService.latest(pageSize, false);
    return c.json(records.map(serializeRecord));
}

async function getRecord(c: Context) {
    const id = c.req.param("id");
    const recordId = parseInt(id, 10);
    console.log("id", id, "recordId", recordId);

    if (isNaN(recordId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const record = await recordManager.findById(recordId);

    if (!record) {
        return c.json({ error: "Record not found" }, 404);
    }

    await recordService.attachPayload(record);

    return c.json(serializeRecord(record));
}

async function deleteRecord(c: Context) {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) {
        return c.json({ error: "Invalid ID" }, 400);
    }

    const deleted = await recordManager.deleteById(id);
    if (!deleted) {
        return c.json({ error: "Record not found" }, 404);
    }

    return c.json({ success: true });
}

async function clearPayload(c: Context) {
    const cleared = await recordService.clearPayloads();
    return c.json({ success: true, cleared });
}

async function clearAll(c: Context) {
    const count = await recordManager.count();
    await recordManager.deleteAll();
    return c.json({ success: true, deleted: count });
}

async function recoverOrphans(c: Context) {
    const thresholdMs = await configService.getNumber(ConfigKey.ORPHAN_RECOVER_THRESHOLD_MS);
    // getNumber() 对未配置/非法值返回 0，回退默认阈值 10 分钟
    const recovered = await recordManager.recoverOrphans(thresholdMs > 0 ? thresholdMs : 600000);
    return c.json({ success: true, recovered });
}

export default {
    listRecords,
    latestRecords,
    getRecord,
    deleteRecord,
    clearPayload,
    clearAll,
    recoverOrphans,
};
