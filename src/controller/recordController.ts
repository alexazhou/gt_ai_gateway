import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import recordService from "../service/recordService";
import { parsePaginationQuery } from "../util/pagination";

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

    const q = SgRecord.query();

    if (status) {
        q.where("status", status);
    }
    if (start_time) {
        q.where("created_at", ">=", start_time);
    }
    if (end_time) {
        q.where("created_at", "<=", end_time);
    }
    if (userIds && userIds.length > 0) {
        q.whereIn("user_id", userIds);
    }
    if (modelIds && modelIds.length > 0) {
        q.whereIn("model_id", modelIds);
    }

    const total = Number(await q.clone().count() || 0);
    const records = await q.orderBy("id", "desc").limit(pageSize).offset(offset).get();

    return c.json({
        list: records.map(serializeRecord),
        total,
    });
}

async function latestRecords(c: Context) {
    const query = c.req.query();
    const { pageSize } = parsePaginationQuery(query, 10);
    const records = await recordService.latest(pageSize);
    return c.json(records.map(serializeRecord));
}

async function getRecord(c: Context) {
    const id = c.req.param("id");
    const recordId = parseInt(id, 10);
    console.log("id", id, "recordId", recordId);

    if (isNaN(recordId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const record = await SgRecord.query().find(recordId);

    if (!record) {
        return c.json({ error: "Record not found" }, 404);
    }

    return c.json(serializeRecord(record));
}

export default {
    listRecords,
    latestRecords,
    getRecord,
};
