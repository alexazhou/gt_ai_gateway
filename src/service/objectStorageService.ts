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
        let deleted = 0;
        let previousFirstKey: string | null = null;

        // P2-13：原实现先把整批 key 全收进 deleteBatches 再删 —— 前缀下有几十万对象时
        // 等于把 key 列表全驻留内存（Worker 128MB 很容易被顶爆）。
        // 改为「每页立即删」：内存只驻留一页（≤1000 key）。
        //
        // 注意不要在「边删边用 cursor」的方式下推进：R2 的 list cursor 是基于当前页内容的位置游标，
        // 删掉已列出的对象后再用旧 cursor 可能跳过或被判失效。这里每轮都从头部重新 list，
        // 已删的对象不会再返回，天然收敛。
        for (;;) {
            const page = await bucket.list({ limit: 1000, prefix });
            const keys = page.objects.map(object => object.key);
            if (keys.length === 0) {
                break;
            }

            // 防御：上一轮删掉的 key 这轮又回来了（删除没生效 / 一致性延迟），别死循环
            if (previousFirstKey !== null && keys[0] === previousFirstKey) {
                console.warn("[objectStorageService] deleteByPrefixFromLocation 未推进，提前结束：", prefix);
                break;
            }
            previousFirstKey = keys[0];

            await bucket.delete(keys);
            deleted += keys.length;

            if (!page.truncated) {
                break;
            }
        }

        return deleted;
    }

    return storageManager.deleteFromTableByPrefix(prefix);
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
};
