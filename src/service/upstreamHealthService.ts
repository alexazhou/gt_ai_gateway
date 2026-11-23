import { ApiFormat, UPSTREAM_FAILURE_COOLDOWN_MS } from "../constants";


enum UpstreamHealthState {
    NORMAL = "normal",
    DOWN = "down",
}


interface UpstreamHealthStatus {
    state: UpstreamHealthState;
    lastFailureAt: number | null;
}


const HEALTH_KEY_PREFIX = "upstream-health:";

/**
 * 进程内冷却记录（key → 失败时刻）。
 *
 * **跨 isolate 不共享** —— 2026-11-16 Operator 决定（#287）：限流与冷却都不用数据库，
 * `upstream_health` 表连同 migrate_0033 一并撤销。Worker 下每个 isolate 各有一份，
 * 某个 isolate 标记的 DOWN 不会让其他 isolate 也跳过该上游。
 *
 * 这是**有意接受的取舍**，不是缺陷：冷却是「少打几次坏上游」的尽力优化，为它维护一张
 * 只在 Worker 路径读写的表，成本（迁移 + 每请求读放大 + 4s TTL 同步 + 过期行清扫）
 * 大于收益。要跨 isolate 精确共享时应改 Durable Object / Redis
 * （`src/util/stateStore/` 留有 `durable_object` / `redis` 后端位，当前实现为空壳会抛错，
 * 禁止静默回落）。
 */
const localFailures = new Map<string, number>();


function buildKey(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
): string {
    return `${HEALTH_KEY_PREFIX}${vendorId}:${vendorModelName}:${apiFormat}`;
}


/**
 * 标记上游失败（冷却开始）。写进程内缓存，本 isolate 立刻生效。
 *
 * 保持 async 签名：调用方（senderService）在失败处理链上 await，
 * 改成同步会波及调用点；语义上这里已无 I/O。
 */
async function markFailure(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
    failedAt: Date = new Date(),
): Promise<void> {
    const key = buildKey(vendorId, vendorModelName, apiFormat);
    localFailures.set(key, failedAt.getTime());
}


// 判定某次失败是否应记录为上游健康问题（触发冷却）
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
    return removed;
}


async function clear(): Promise<void> {
    localFailures.clear();
}


export { UpstreamHealthState, UpstreamHealthStatus };
export default {
    markFailure,
    getHealthStatus,
    shouldMarkFailure,
    pruneExpired,
    clear,
};
