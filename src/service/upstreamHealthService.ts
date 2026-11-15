import { ApiFormat, UPSTREAM_FAILURE_COOLDOWN_MS } from "../constants";
import type { UpstreamHealthRecord, UpstreamHealthStore } from "../util/health/sqlHealthStore";
import { SqlUpstreamHealthStore } from "../util/health/sqlHealthStore";
import ormService from "./ormService";
import OrmSqlExecutor from "./sqlExecutorService";


enum UpstreamHealthState {
    NORMAL = "normal",
    DOWN = "down",
}


interface UpstreamHealthStatus {
    state: UpstreamHealthState;
    lastFailureAt: number | null;
}


const HEALTH_KEY_PREFIX = "upstream-health:";

// isolate 本地读缓存的有效期：跨 isolate 同步靠它压读放大（3~5s 级的最终一致）
const LOCAL_CACHE_TTL_MS = 4_000;
// 过期行的清扫间隔：冷却窗口外的行已无意义，但不必每次同步都删（写放大）
const PRUNE_INTERVAL_MS = 10 * 60_000;

/**
 * 本 isolate 已知的冷却记录（key → 失败时刻）。
 *
 * 路由选路（isDown）是同步路径，不能在这里做 DB I/O，所以读走这份本地缓存：
 * - Worker：每次请求进入路由前调用 syncFromStore() 用 DB 全量刷新（4s TTL 内不重复读）；
 * - Node：单进程内内存即事实来源，不需要同步。
 */
const localFailures = new Map<string, number>();

// 注入的持久化实现（测试可替换）；null 表示当前模式无需持久化
let storeOverride: UpstreamHealthStore | null = null;
let workerStore: UpstreamHealthStore | null = null;
let lastSyncAt = 0;
let lastPruneAt = 0;

function resolveStore(): UpstreamHealthStore | null {
    if (storeOverride) {
        return storeOverride;
    }
    // Node / 桌面：单进程，内存即事实来源，不需要持久化与跨实例同步
    // isWorker 默认 true，未 init 时不能碰 dbAdapter；未就绪同样降级为纯内存
    if (!ormService.isWorker || !ormService.isReady) {
        return null;
    }
    if (!workerStore) {
        workerStore = new SqlUpstreamHealthStore(new OrmSqlExecutor());
    }
    return workerStore;
}


function buildKey(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
): string {
    return `${HEALTH_KEY_PREFIX}${vendorId}:${vendorModelName}:${apiFormat}`;
}


/**
 * 标记上游失败（冷却开始）。
 *
 * 先写本地缓存（本 isolate 立刻生效），再落库（其他 isolate 在下一次 syncFromStore 时看到）。
 * 写库失败不阻塞请求链路：冷却是「尽力而为」的优化，不能因为它让正常的 failover 逻辑失败。
 */
async function markFailure(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
    failedAt: Date = new Date(),
): Promise<void> {
    const key = buildKey(vendorId, vendorModelName, apiFormat);
    const failedAtMs = failedAt.getTime();
    localFailures.set(key, failedAtMs);

    const store = resolveStore();
    if (!store) {
        return;
    }
    try {
        await store.markFailure(key, failedAtMs);
    } catch (e) {
        console.warn("[upstreamHealthService] Failed to persist upstream failure:", e);
    }
}


/**
 * 把库里的冷却状态同步到本 isolate（Worker 用）。TTL 内直接返回，避免每请求一次 D1 读。
 * 以 DB 为准做整表替换，避免本地缓存里过期的 DOWN 状态长期残留。
 */
async function syncFromStore(now: number = Date.now(), force: boolean = false): Promise<void> {
    const store = resolveStore();
    if (!store) {
        return;
    }
    if (!force && lastSyncAt !== 0 && now - lastSyncAt < LOCAL_CACHE_TTL_MS) {
        return;
    }

    try {
        const records: UpstreamHealthRecord[] = await store.listFailuresSince(now - UPSTREAM_FAILURE_COOLDOWN_MS);
        localFailures.clear();
        for (const record of records) {
            localFailures.set(record.key, record.failedAt);
        }
        lastSyncAt = now;
    } catch (e) {
        // 同步失败时保留本地状态继续服务（降级为 isolate 内冷却，不阻断请求）
        console.warn("[upstreamHealthService] Failed to sync upstream health from store:", e);
        return;
    }

    // 过期行清扫：冷却窗口外的记录已无意义，不定期清理会让表只增不减
    if (lastPruneAt === 0 || now - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = now;
        try {
            await store.prune(now - UPSTREAM_FAILURE_COOLDOWN_MS);
        } catch (e) {
            console.warn("[upstreamHealthService] Failed to prune upstream health rows:", e);
        }
    }
}


// 判定某次失败是否应记录为上游健康问题（触发全局冷却）
// 仅"上游自身故障"需要记录：5xx 服务端错误、402 余额不足、网络不可达（无 HTTP 状态码）
// 4xx 属于请求侧/配置侧错误（400/401/403/404/429 等），上游本身健康，不应被冷却
function shouldMarkFailure(status: number | null): boolean {
    if (status === null) {
        return true;
    }
    return status >= 500 || status === 402;
}


function getHealthStatus(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
    now: number = Date.now(),
): UpstreamHealthStatus {
    const key = buildKey(vendorId, vendorModelName, apiFormat);
    const failedAt = localFailures.get(key);
    if (failedAt === undefined) {
        return { state: UpstreamHealthState.NORMAL, lastFailureAt: null };
    }
    if (now - failedAt >= UPSTREAM_FAILURE_COOLDOWN_MS) {
        localFailures.delete(key);
        return { state: UpstreamHealthState.NORMAL, lastFailureAt: null };
    }
    return { state: UpstreamHealthState.DOWN, lastFailureAt: failedAt };
}


async function pruneExpired(now: number = Date.now()): Promise<number> {
    let removed = 0;
    for (const [key, failedAt] of localFailures) {
        if (now - failedAt >= UPSTREAM_FAILURE_COOLDOWN_MS) {
            localFailures.delete(key);
            removed++;
        }
    }

    const store = resolveStore();
    if (store) {
        lastPruneAt = now;
        try {
            await store.prune(now - UPSTREAM_FAILURE_COOLDOWN_MS);
        } catch (e) {
            console.warn("[upstreamHealthService] Failed to prune expired upstream health rows:", e);
        }
    }
    return removed;
}


async function clear(): Promise<void> {
    localFailures.clear();
    lastSyncAt = 0;
    lastPruneAt = 0;

    const store = resolveStore();
    if (store) {
        await store.clear();
    }
}


/** 测试用：替换持久化实现（传 null 恢复默认解析） */
function setStore(implementation: UpstreamHealthStore | null): void {
    storeOverride = implementation;
    localFailures.clear();
    lastSyncAt = 0;
    lastPruneAt = 0;
}


export { UpstreamHealthState, UpstreamHealthStatus };
export default {
    markFailure,
    syncFromStore,
    getHealthStatus,
    shouldMarkFailure,
    pruneExpired,
    clear,
    setStore,
};
