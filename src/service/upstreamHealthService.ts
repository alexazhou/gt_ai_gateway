import { ApiFormat, UPSTREAM_FAILURE_COOLDOWN_MS } from "../constants";
import cacheService from "./cacheService";


interface UpstreamHealthEntry {
    last_failure_at: number;
}


enum UpstreamHealthState {
    NORMAL = "normal",
    DOWN = "down",
}


interface UpstreamHealthStatus {
    state: UpstreamHealthState;
    lastFailureAt: number | null;
}


const HEALTH_KEY_PREFIX = "upstream-health:";


function buildKey(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
): string {
    return `${HEALTH_KEY_PREFIX}${vendorId}:${vendorModelName}:${apiFormat}`;
}


function markFailure(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
    failedAt: Date = new Date(),
): void {
    cacheService.set(
        buildKey(vendorId, vendorModelName, apiFormat),
        { last_failure_at: failedAt.getTime() },
    );
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
    const entry = cacheService.get<UpstreamHealthEntry>(key);
    if (!entry) {
        return { state: UpstreamHealthState.NORMAL, lastFailureAt: null };
    }
    if (now - entry.last_failure_at >= UPSTREAM_FAILURE_COOLDOWN_MS) {
        cacheService.del(key);
        return { state: UpstreamHealthState.NORMAL, lastFailureAt: null };
    }
    return { state: UpstreamHealthState.DOWN, lastFailureAt: entry.last_failure_at };
}


function pruneExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, value] of cacheService.entries()) {
        if (!key.startsWith(HEALTH_KEY_PREFIX)) {
            continue;
        }
        const entry = value as UpstreamHealthEntry;
        if (now - entry.last_failure_at >= UPSTREAM_FAILURE_COOLDOWN_MS) {
            cacheService.del(key);
            removed++;
        }
    }
    return removed;
}


function clear(): void {
    for (const [key] of cacheService.entries()) {
        if (key.startsWith(HEALTH_KEY_PREFIX)) {
            cacheService.del(key);
        }
    }
}

export { UpstreamHealthState, UpstreamHealthStatus };
export default {
    markFailure,
    getHealthStatus,
    shouldMarkFailure,
    pruneExpired,
    clear,
};
