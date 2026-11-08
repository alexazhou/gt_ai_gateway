import ormService from "./ormService";
import configService from "./configService";
import storageManager from "../manager/storageManager";
import { ConfigKey, RecordPayloadStorage } from "../constants";
import customError from "../customError";

let r2Bucket: R2Bucket | null = null;

function setR2Bucket(bucket: R2Bucket | null | undefined) {
    r2Bucket = bucket ?? null;
}

function assertValidKey(key: string) {
    if (!key || !key.trim()) {
        throw new customError.AppError("object key is required", 400);
    }
}

function assertValidPrefix(prefix: string) {
    if (!prefix || !prefix.trim()) {
        throw new customError.AppError("object key prefix is required", 400);
    }
}

function getWorkerBucket(): R2Bucket {
    if (!r2Bucket) {
        throw new customError.AppError("R2 object bucket is not configured", 500);
    }
    return r2Bucket;
}

function isValidStorageLocation(value: string): value is RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2 {
    return value === RecordPayloadStorage.DATABASE || value === RecordPayloadStorage.R2;
}

async function resolveStorageLocation(): Promise<RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2> {
    const configured = (await configService.getConfig(ConfigKey.RECORD_PAYLOAD_STORAGE)).getString().trim();
    if (isValidStorageLocation(configured)) {
        return configured;
    }

    if (ormService.isWorker && r2Bucket) {
        return RecordPayloadStorage.R2;
    }

    return RecordPayloadStorage.DATABASE;
}

function alternateStorageLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
): RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2 {
    return location === RecordPayloadStorage.R2
        ? RecordPayloadStorage.DATABASE
        : RecordPayloadStorage.R2;
}

function isLocationAvailable(location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2): boolean {
    if (location === RecordPayloadStorage.R2) {
        return r2Bucket !== null;
    }
    return true;
}

function assertLocationAvailable(location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2) {
    if (location === RecordPayloadStorage.R2) {
        getWorkerBucket();
    }
}

async function putToLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    key: string,
    data: Uint8Array,
) {
    if (location === RecordPayloadStorage.R2) {
        await getWorkerBucket().put(key, data);
        return;
    }

    await storageManager.putToTable(key, data);
}

async function getFromLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    key: string,
): Promise<Uint8Array | null> {
    if (location === RecordPayloadStorage.R2) {
        const object = await getWorkerBucket().get(key);
        if (!object) {
            return null;
        }
        return new Uint8Array(await object.arrayBuffer());
    }

    const object = await storageManager.getFromTable(key);
    return object?.data ?? null;
}

async function deleteFromLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    key: string,
) {
    if (location === RecordPayloadStorage.R2) {
        await getWorkerBucket().delete(key);
        return;
    }

    await storageManager.deleteFromTable(key);
}

async function deleteByPrefixFromLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    prefix: string,
): Promise<number> {
    if (location === RecordPayloadStorage.R2) {
        const bucket = getWorkerBucket();
        let cursor: string | undefined;
        const deleteBatches: string[][] = [];
        let deleted = 0;

        do {
            const page = await bucket.list({ cursor, limit: 1000, prefix });
            const keys = page.objects.map(object => object.key);
            if (keys.length > 0) {
                deleteBatches.push(keys);
                deleted += keys.length;
            }
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);

        for (const keys of deleteBatches) {
            await bucket.delete(keys);
        }

        return deleted;
    }

    return storageManager.deleteFromTableByPrefix(prefix);
}

/**
 * 列出某存储位置下某前缀的全部 object_key（**不含 data 内容**）。
 * R2 侧按 cursor 翻页；DATABASE 侧只 select key 列，不把 BLOB 读进内存。
 */
async function listKeysFromLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    prefix: string,
): Promise<string[]> {
    if (location === RecordPayloadStorage.R2) {
        const bucket = getWorkerBucket();
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await bucket.list({ cursor, limit: 1000, prefix });
            keys.push(...page.objects.map(object => object.key));
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return keys;
    }

    return storageManager.listKeysByPrefix(prefix);
}

/**
 * 列出某前缀下的全部 object_key（主存储 + 备用存储，**去重后返回 key 列表**）。
 *
 * 两侧都列：payload 可能因历史切换配置而残留在另一侧，只扫当前存储位置会漏掉孤儿。
 * 去重是为了让调用方拿到的「条数」等于 payload 条数，而不是「存放份数」；
 * 真正的删除走 `deleteMany` → `deleteObject`，它本来就会把主备两侧一起删。
 */
async function listKeysByPrefix(prefix: string): Promise<string[]> {
    assertValidPrefix(prefix);

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);

    const keys = new Set(await listKeysFromLocation(location, prefix));

    const fallback = alternateStorageLocation(location);
    if (isLocationAvailable(fallback)) {
        for (const key of await listKeysFromLocation(fallback, prefix)) {
            keys.add(key);
        }
    }

    return [...keys];
}


/** 按 key 批量删除（孤儿清理用；每个 key 主备两侧都删，与实际存放位置无关） */
async function deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
        assertValidKey(key);
        await deleteObject(key);
        deleted += 1;
    }
    return deleted;
}

async function put(key: string, data: Uint8Array) {
    assertValidKey(key);

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);
    await putToLocation(location, key, data);

    const fallback = alternateStorageLocation(location);
    if (isLocationAvailable(fallback)) {
        await deleteFromLocation(fallback, key);
    }
}

async function get(key: string): Promise<Uint8Array | null> {
    assertValidKey(key);

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);

    const primary = await getFromLocation(location, key);
    if (primary) {
        return primary;
    }

    const fallback = alternateStorageLocation(location);
    if (!isLocationAvailable(fallback)) {
        return null;
    }

    return getFromLocation(fallback, key);
}

async function deleteObject(key: string) {
    assertValidKey(key);

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);

    await deleteFromLocation(location, key);

    const fallback = alternateStorageLocation(location);
    if (isLocationAvailable(fallback)) {
        await deleteFromLocation(fallback, key);
    }
}


async function deleteByPrefix(prefix: string): Promise<number> {
    assertValidPrefix(prefix);

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);

    let deleted = await deleteByPrefixFromLocation(location, prefix);

    const fallback = alternateStorageLocation(location);
    if (isLocationAvailable(fallback)) {
        deleted += await deleteByPrefixFromLocation(fallback, prefix);
    }

    return deleted;
}


async function putText(key: string, text: string) {
    await put(key, new TextEncoder().encode(text));
}

async function getText(key: string): Promise<string | null> {
    const data = await get(key);
    if (!data) {
        return null;
    }
    return new TextDecoder().decode(data);
}

export default {
    setR2Bucket,
    put,
    get,
    delete: deleteObject,
    deleteByPrefix,
    putText,
    getText,
    listKeysByPrefix,
    deleteMany,
};
