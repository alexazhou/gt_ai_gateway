import ormService from "./ormService";
import configService from "./configService";
import storageManager from "../manager/storageManager";
import { ConfigKey, RecordPayloadStorage } from "../constants";
import customError from "../customError";

let r2Bucket: R2Bucket | null = null;

/** R2 `list()` 单次最多返回的 key 条数（Cloudflare 硬限制，超过直接报错） */
const R2_LIST_MAX_KEYS = 1000;

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

/**
 * 分页列出某存储位置下某前缀的 object_key（**不含 data 内容**）。
 *
 * - R2：用 `startAfter` 做 keyset 翻页（不用 cursor，因为调用方边扫边删，
 *   删过的 key 不该再影响下一页的起点）；
 * - DATABASE：`object_key` 主键 keyset 翻页，只 select key 列，不把 BLOB 读进内存。
 *
 * @param afterKey 上一页最后一个 key；null/undefined 表示从该前缀的第一页开始
 */
async function listKeyPageFromLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    prefix: string,
    afterKey: string | null | undefined,
    limit: number,
): Promise<string[]> {
    if (location === RecordPayloadStorage.R2) {
        return await listR2KeyPage(getWorkerBucket(), prefix, afterKey, limit);
    }

    return storageManager.listKeysPage(prefix, afterKey, limit);
}

/**
 * R2 侧的一页：内部按 R2 单次上限（1000）分次取，凑够 limit 条或取空为止。
 *
 * R2 `list()` 的 limit 上限是 1000（超过直接报 `MaxKeys params must be positive
 * integer <= 1000`），而本函数收到的 limit 来自调用方——孤儿清理一片最多 5000。
 * 所以在 R2 侧必须自己续取，而不是把 limit 直接透传下去。
 * 对外语义不变：「从 afterKey 之后开始的至多 limit 条、按 key 升序」。
 */
async function listR2KeyPage(
    bucket: R2Bucket,
    prefix: string,
    afterKey: string | null | undefined,
    limit: number,
): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined = afterKey ?? undefined;

    while (keys.length < limit) {
        const pageSize = Math.min(R2_LIST_MAX_KEYS, limit - keys.length);
        const page = await bucket.list({
            prefix,
            limit: pageSize,
            ...(cursor ? { startAfter: cursor } : {}),
        });
        const pageKeys = page.objects.map(object => object.key);
        keys.push(...pageKeys);

        // 本页没取满说明该前缀下已经没有更多 key 了
        if (pageKeys.length < pageSize) {
            break;
        }
        cursor = pageKeys[pageKeys.length - 1];
    }

    return keys;
}

/**
 * 分页列出某前缀下的 object_key（主存储 + 备用存储合并去重，按 key 升序）。
 *
 * 两侧都扫：payload 可能因历史切换配置而残留在另一侧，只扫当前存储位置会漏掉孤儿。
 * 合并方式是「两个有序流归并」，不需要把任一侧全量读进内存：
 * 每侧各自维护 keyset 游标，反复取两侧当前最小 key 产出，同 key 只产出一次。
 * 真正删除走 `deleteObject`，它本来就把主备两侧一起删。
 *
 * 返回值语义：只保证「按 key 升序、不重复、覆盖主备两侧」，条数即 payload 条数（不是存放份数）。
 */
async function listKeyPage(
    prefix: string,
    afterKey: string | null | undefined,
    limit: number,
): Promise<string[]> {
    assertValidPrefix(prefix);

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);

    const fallback = alternateStorageLocation(location);
    if (!isLocationAvailable(fallback)) {
        return await listKeyPageFromLocation(location, prefix, afterKey, limit);
    }

    return await mergeKeyStreams(
        cursor => listKeyPageFromLocation(location, prefix, cursor, limit),
        cursor => listKeyPageFromLocation(fallback, prefix, cursor, limit),
        afterKey,
        limit,
    );
}


/**
 * 把两个「按 key 升序分页」的流归并成一条升序去重流，只取前 limit 条。
 *
 * 两侧各缓存一页（每页 limit 条），每次吐出当前最小的 key 并推进该侧游标；
 * 某一侧耗尽后直接抽另一侧。内存上限 ≈ 2×limit，与总条数无关。
 *
 * 去重按「相同 key 连续出现只吐一次」实现：两流都升序，同一个 key 在两流里必然相邻产出。
 */
async function mergeKeyStreams(
    fetchPrimary: (afterKey: string | null) => Promise<string[]>,
    fetchFallback: (afterKey: string | null) => Promise<string[]>,
    afterKey: string | null | undefined,
    limit: number,
): Promise<string[]> {
    const state = {
        primary: { buffer: [] as string[], cursor: afterKey ?? null, done: false },
        fallback: { buffer: [] as string[], cursor: afterKey ?? null, done: false },
    };

    const refill = async (side: typeof state.primary, fetch: (afterKey: string | null) => Promise<string[]>) => {
        if (side.buffer.length > 0 || side.done) {
            return;
        }
        const page = await fetch(side.cursor);
        side.buffer = page;
        if (page.length === 0) {
            side.done = true;
            return;
        }
        side.cursor = page[page.length - 1];
    };

    const out: string[] = [];
    let lastEmitted: string | null = null;

    while (out.length < limit) {
        await refill(state.primary, fetchPrimary);
        await refill(state.fallback, fetchFallback);

        const headPrimary = state.primary.buffer[0];
        const headFallback = state.fallback.buffer[0];

        if (headPrimary === undefined && headFallback === undefined) {
            break;
        }

        let next: string;
        if (headPrimary === undefined) {
            next = state.fallback.buffer.shift() as string;
        } else if (headFallback === undefined) {
            next = state.primary.buffer.shift() as string;
        } else if (headPrimary <= headFallback) {
            next = state.primary.buffer.shift() as string;
            if (headPrimary === headFallback) {
                state.fallback.buffer.shift();
            }
        } else {
            next = state.fallback.buffer.shift() as string;
        }

        if (next === lastEmitted) {
            continue;
        }
        lastEmitted = next;
        out.push(next);
    }

    return out;
}


/**
 * 统计某前缀下的 object_key 条数（主备两侧取并集）。
 *
 * 孤儿清理进度条的分母用：只在清理开始前取一次快照，之后不再 count
 * （边删边 count 分母会缩水，进度条会往回跳）。
 *
 * R2 只能靠列表翻页数出来（没有 count 接口）；DATABASE 直接 COUNT。
 */
async function countKeys(prefix: string): Promise<number> {
    assertValidPrefix(prefix);

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);

    const fallback = alternateStorageLocation(location);
    if (!isLocationAvailable(fallback)) {
        return countKeysInLocation(location, prefix);
    }

    // 两侧可能有同一个 key（切换配置前的残留），并集条数不能简单相加。
    // 这里按 key 流归并数「不重复的 key 个数」，与 listKeyPage 的口径保持一致。
    let total = 0;
    let afterKey: string | null = null;
    const MERGE_PAGE = 1000;
    while (true) {
        const page = await listKeyPage(prefix, afterKey, MERGE_PAGE);
        if (page.length === 0) {
            break;
        }
        total += page.length;
        afterKey = page[page.length - 1];
    }
    return total;
}

async function countKeysInLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    prefix: string,
): Promise<number> {
    if (location === RecordPayloadStorage.R2) {
        const bucket = getWorkerBucket();
        let cursor: string | undefined;
        let total = 0;
        do {
            const page = await bucket.list({ cursor, limit: 1000, prefix });
            total += page.objects.length;
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return total;
    }

    return storageManager.countByPrefix(prefix);
}

/**
 * 批量删除一批 key（主备两侧都删，与实际存放位置无关）。
 *
 * **必须批量**：逐条 `deleteObject` 会让每个 key 至少吃掉一条数据库语句，worker 模式下
 * D1 对单次请求有 1000 条查询的硬上限，一页上千个 key 逐条删就把预算吃光了。
 * 这里每批压成一条语句（DATABASE 用 `WHERE object_key IN (...)`，R2 原生支持 key 数组），
 * 批大小仍按 `bindParamBatchSize()` 取，不受单条语句绑定参数上限影响。
 *
 * 返回删除的 key 条数（不是存放份数）。
 */
async function deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) {
        return 0;
    }
    for (const key of keys) {
        assertValidKey(key);
    }

    const location = await resolveStorageLocation();
    assertLocationAvailable(location);
    await deleteManyFromLocation(location, keys);

    const fallback = alternateStorageLocation(location);
    if (isLocationAvailable(fallback)) {
        await deleteManyFromLocation(fallback, keys);
    }

    return keys.length;
}

async function deleteManyFromLocation(
    location: RecordPayloadStorage.DATABASE | RecordPayloadStorage.R2,
    keys: string[],
) {
    if (location === RecordPayloadStorage.R2) {
        // R2 单次最多 1000 个 key，超过就分片
        const R2_DELETE_CHUNK = 1000;
        for (let i = 0; i < keys.length; i += R2_DELETE_CHUNK) {
            await getWorkerBucket().delete(keys.slice(i, i + R2_DELETE_CHUNK));
        }
        return;
    }

    await storageManager.deleteFromTableByKeys(keys);
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
    listKeyPage,
    countKeys,
    deleteMany,
};
