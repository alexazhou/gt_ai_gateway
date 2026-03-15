import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import recordService from "../service/recordService";

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
    const { page, pageSize } = c.req.query();
    const pageNum = page ? parseInt(page, 10) : 1;
    const limit = pageSize ? parseInt(pageSize, 10) : 10;
    const offset = (pageNum - 1) * limit;

    // 使用 COUNT 查询获取总数
    const query = SgRecord.query();
    const countResult = await query.clone().count();
    const total = Number(countResult || 0);

    // 分页获取数据
    const records = await SgRecord.query()
        .orderBy("id", "desc")
        .limit(limit)
        .offset(offset)
        .get();

    return c.json({
        list: records.map(serializeRecord),
        total: total,
    });
}

async function latestRecords(c: Context) {
    const { limit } = c.req.query();
    const limitNumber = limit ? parseInt(limit, 10) : 10;
    const records = await recordService.latest(limitNumber);
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
