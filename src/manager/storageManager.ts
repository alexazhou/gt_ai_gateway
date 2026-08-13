import { SgStorageRecord } from "../model/sgStorageRecord";
import customError from "../util/customError";

interface StoredObject {
    object_key: string;
    data: Uint8Array;
    size_bytes: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}


function normalizeBytes(data: unknown): Uint8Array {
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


function toDatabaseBytes(data: Uint8Array): Uint8Array {
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

async function deleteFromTableByPrefix(prefix: string): Promise<number> {
    const pattern = `${prefix}%`;
    const deleted = await SgStorageRecord.query().where("object_key", "like", pattern).delete();
    return Number(deleted || 0);
}

export type { StoredObject };

export default {
    putToTable,
    getFromTable,
    deleteFromTable,
    deleteFromTableByPrefix,
};
