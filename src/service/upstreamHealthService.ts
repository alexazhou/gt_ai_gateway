import { ApiFormat, UPSTREAM_FAILURE_COOLDOWN_MS } from "../constants";
import stateStoreService from "./stateStoreService";
import { StateStoreUnavailableError } from "../util/stateStore";


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
 * 冷却记录落在全局 `StateStore`（key = `upstream-health:{vendorId}:{vendorModelName}:{apiFormat}`，
 * 值 = 失败时刻的 epoch 毫秒字符串，`ttlMs = UPSTREAM_FAILURE_COOLDOWN_MS`）。
 *
 * **跨 isolate 仍不共享** —— 2026-11-16 Operator 决定（#287）：限流与冷却都不用数据库，
 * `upstream_health` 表连同 migrate_0033 一并撤销。`memory` 后端是 per-isolate 的，
 * Worker 下某个 isolate 标记的 DOWN 不会让其他 isolate 也跳过该上游。
 *
 * 这是**有意接受的取舍**，不是缺陷：冷却是「少打几次坏上游」的尽力优化，为它维护一张
 * 只在 Worker 路径读写的表，成本（迁移 + 每请求读放大 + 4s TTL 同步 + 过期行清扫）
 * 大于收益。要跨 isolate 精确共享时应换 `durable_object` / `redis` 后端
 * （`src/util/stateStore/` 留有后端位，当前为空壳会抛错，禁止静默回落）。
 *
 * 过期判定交给 StateStore 的 `ttlMs`：写入时打 TTL，读取时按 `nowMs` 惰性判过期，
 * 不需要「扫描 + 删除过期行」的清扫线程（原 `pruneExpired` 因此下线）。
 */


function buildKey(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
): string {
    return `${HEALTH_KEY_PREFIX}${vendorId}:${vendorModelName}:${apiFormat}`;
}


function warnUnavailable(action: string, key: string, err: unknown): void {
    console.warn(
        `[upstreamHealthService] StateStore unavailable on ${action} for "${key}", fail-open:`,
        err instanceof Error ? err.message : err,
    );
}


/**
 * 标记上游失败（冷却开始）。写 StateStore，`ttlMs = UPSTREAM_FAILURE_COOLDOWN_MS`。
 *
 * 保持 async 签名：调用方（senderService）在失败处理链上 await，改成同步会波及调用点。
 *
 * **fail-open**：冷却只是「少打几次坏上游」的优化，状态后端不可用时只告警、不写记录，
 * 绝不因冷却写失败而中断正在处理的请求（契约见 `src/util/stateStore/types.ts` 第 2 条）。
 */
async function markFailure(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
    failedAt: Date = new Date(),
): Promise<void> {
    const key = buildKey(vendorId, vendorModelName, apiFormat);
    try {
        await stateStoreService.getStore().set(key, String(failedAt.getTime()), {
            ttlMs: UPSTREAM_FAILURE_COOLDOWN_MS,
            nowMs: failedAt.getTime(),
        });
    } catch (err) {
        if (err instanceof StateStoreUnavailableError) {
            warnUnavailable("markFailure", key, err);
            return;
        }
        throw err;
    }
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


/**
 * 查上游健康状态。键不存在或已过期 ⇒ NORMAL；存在 ⇒ DOWN + 失败时刻。
 *
 * 由同步改 async：StateStore 契约要求所有方法返回 Promise（DO / Redis 的原子操作天然异步），
 * 调用链（路由策略 → routingService.core → senderService）已逐层改为 await。
 *
 * **fail-open**：状态后端不可用时按 NORMAL 放行（告警，不阻断转发）。
 */
async function getHealthStatus(
    vendorId: number,
    vendorModelName: string,
    apiFormat: ApiFormat,
    now: number = Date.now(),
): Promise<UpstreamHealthStatus> {
    const key = buildKey(vendorId, vendorModelName, apiFormat);
    let raw: string | null;
    try {
        raw = await stateStoreService.getStore().get(key, { nowMs: now });
    } catch (err) {
        if (err instanceof StateStoreUnavailableError) {
            warnUnavailable("getHealthStatus", key, err);
            return { state: UpstreamHealthState.NORMAL, lastFailureAt: null };
        }
        throw err;
    }
    if (raw === null) {
        return { state: UpstreamHealthState.NORMAL, lastFailureAt: null };
    }
    const failedAt = Number(raw);
    if (!Number.isFinite(failedAt)) {
        // 值被外部写坏（非本模块写入）：按未命中处理，避免把 NaN 当失败时刻泄漏给调用方
        return { state: UpstreamHealthState.NORMAL, lastFailureAt: null };
    }
    return { state: UpstreamHealthState.DOWN, lastFailureAt: failedAt };
}


export { UpstreamHealthState, UpstreamHealthStatus };
export default {
    markFailure,
    getHealthStatus,
    shouldMarkFailure,
};
