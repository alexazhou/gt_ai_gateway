import { SgStorageRecord } from "../model/sgStorageRecord";
import customError from "../customError";
import { bindParamBatchSize } from "../util/db/bindParamUtil";

interface StoredObject {
    object_key: string;
    data: Uint8Array;
    size_bytes: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}


export function normalizeBytes(data: unknown): Uint8Array {
    // 1. 标准 Uint8Array
    if (data instanceof Uint8Array) {
        return new Uint8Array(data);
    }

    // 2. ArrayBuffer
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    // 3. 其他 TypedArray 或 DataView
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    // 4. 字符串（可能是 base64 编码）
    if (typeof data === "string") {
        return new TextEncoder().encode(data);
    }

    // 5. D1 可能返回的 Buffer 序列化对象: { type: "Buffer", data: [byte1, byte2, ...] }
    if (data !== null && typeof data === "object" && "type" in data && "data" in data) {
        const obj = data as { type: string; data: number[] | Uint8Array };
        if (obj.type === "Buffer" && Array.isArray(obj.data)) {
            return new Uint8Array(obj.data);
        }
    }

    // 6. 鸭子类型：具有 buffer/byteOffset/byteLength 属性的对象
    if (data !== null && typeof data === "object" && "buffer" in data && "byteLength" in data) {
        const typedData = data as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
        return new Uint8Array(typedData.buffer, typedData.byteOffset, typedData.byteLength);
    }

    // 7. 普通 Array（D1 可能返回字节数组）
    if (Array.isArray(data)) {
        return new Uint8Array(data);
    }

    // 8. 数字（单字节）
    if (typeof data === "number") {
        return new Uint8Array([data]);
    }

    // 9. null 或 undefined
    if (data === null || data === undefined) {
        return new Uint8Array(0);
    }

    throw new customError.AppError(`unsupported object data type: ${typeof data}`, 500);
}


export function toDatabaseBytes(data: Uint8Array): Uint8Array {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(data);
    }
    return data;
}


async function putToTable(key: string, data: Uint8Array) {
    const existing = await SgStorageRecord.query().where("object_key", key).first();

    if (existing) {
        await existing.update({
            size_bytes: data.byteLength,
            data: toDatabaseBytes(data),
            updated_at: new Date(),
        });
        return;
    }

    await SgStorageRecord.query().create({
        object_key: key,
        size_bytes: data.byteLength,
        data: toDatabaseBytes(data),
    });
}

async function getFromTable(key: string): Promise<StoredObject | null> {
    const row = await SgStorageRecord.query().where("object_key", key).first();

    if (!row) {
        return null;
    }

    return {
        object_key: row.object_key,
        size_bytes: Number(row.size_bytes ?? 0),
        created_at: row.created_at,
        updated_at: row.updated_at,
        data: normalizeBytes(row.data),
    };
}

async function deleteFromTable(key: string) {
    await SgStorageRecord.query().where("object_key", key).delete();
}

/** 统计某前缀下的 key 条数（只 COUNT，不读 BLOB） */
async function countByPrefix(prefix: string): Promise<number> {
    const pattern = `${prefix}%`;
    const count = await SgStorageRecord.query().where("object_key", "like", pattern).count();
    return Number(count || 0);
}

/**
 * 删除某前缀下的全部 key，返回删除条数。
 *
 * 先 count 再 delete：worker 模式的 D1 方言只取 `run()` 的 `results`，
 * 丢掉 `meta.changes`，`.delete()` 恒返回 0（详见 `requestActivityManager.deleteByRecordIds`）。
 * 直接回报影响行数会一直显示「清了 0 条」。
 */
async function deleteFromTableByPrefix(prefix: string): Promise<number> {
    const pattern = `${prefix}%`;
    const count = await countByPrefix(prefix);
    await SgStorageRecord.query().where("object_key", "like", pattern).delete();
    return count;
}

/**
 * 按 object_key 升序**分页**列出某前缀下的 key（只取 key 列，不加载 data blob）。
 *
 * 翻页用 keyset（`object_key > afterKey`）而不是 `LIMIT/OFFSET`：调用方是边扫边删，
 * 删掉前面的行会让后面所有行的 offset 前移，用 offset 翻页会成片跳过。
 * `object_key` 是主键，keyset 条件 + `ORDER BY object_key` 走同一棵索引，代价与页码无关。
 *
 * @param afterKey 上一页最后一个 key；null/undefined 表示从该前缀的第一页开始
 * @param limit    本页最多返回多少条
 */
async function listKeysPage(prefix: string, afterKey: string | null | undefined, limit: number): Promise<string[]> {
    const pattern = `${prefix}%`;
    const query = SgStorageRecord.query().select("object_key").where("object_key", "like", pattern);
    if (afterKey) {
        query.where("object_key", ">", afterKey);
    }
    const rows = await query.orderBy("object_key", "asc").limit(limit).get();
    return rows.all().map(r => String(r.object_key));
}

/**
 * 按 object_key 批量删除一批 key。
 *
 * 一批压成一条 `WHERE object_key IN (...)`（内部按 `bindParamBatchSize()` 再拆），
 * 而不是每个 key 一次 DELETE：worker 模式下 D1 对单次请求有 1000 条查询上限，
 * 逐条删会把查询预算直接吃光。
 *
 * 返回删除条数。同样先 count 再 delete，理由见 `deleteFromTableByPrefix`。
 */
async function deleteFromTableByKeys(keys: string[]): Promise<number> {
    if (keys.length === 0) {
        return 0;
    }
    const batchSize = bindParamBatchSize();
    let deleted = 0;
    for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        deleted += Number(await SgStorageRecord.query().whereIn("object_key", batch).count() || 0);
        await SgStorageRecord.query().whereIn("object_key", batch).delete();
    }
    return deleted;
}

export type { StoredObject };

export default {
    putToTable,
    getFromTable,
    deleteFromTable,
    deleteFromTableByPrefix,
    deleteFromTableByKeys,
    countByPrefix,
    listKeysPage,
};
