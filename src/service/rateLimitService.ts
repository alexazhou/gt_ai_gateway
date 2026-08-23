import SgRule from "../model/sgRule";
import customError from "../customError";
import memoryRateLimitStore from "../util/rule/memoryRateLimitStore";
import type { RateLimitStore, RequestContext } from "../util/rule/types";

// 重试建议秒数：滑动窗口两桶加权模型不记录单个请求时间戳，60s 为保守上限，客户端等满一个窗口再重试
const RETRY_AFTER_SECONDS = 60;

// 注入的计数器存储实现：默认内存滑动窗口，测试可替换
let store: RateLimitStore = memoryRateLimitStore;

function setStore(implementation: RateLimitStore): void {
    store = implementation;
}

interface CheckAndAdmitOptions {
    /** 阶段二（供应商级限流）传 true：抛出的 RateLimitError 带 failover 标记，供路由循环识别换上游 */
    failoverEligible?: boolean;
}

/**
 * 限流准入：RPM 先加后判（check + record 一步完成），超限抛 RateLimitError（429）。
 * - config.rpm 为 null / 缺省 → 不限制（规则命中但放行）
 * - config.rpm 为 0 → 不可用（无请求额度，所有命中请求一律 429，可作硬性阻断）
 * - config.rpm 为 N（N > 0）→ 60s 滑动窗口内最多 N 个请求
 */
async function checkAndAdmit(rule: SgRule, ctx: RequestContext, opts: CheckAndAdmitOptions = {}): Promise<void> {
    const failoverEligible = opts.failoverEligible ?? false;
    const rpm = (rule.config ?? {}).rpm;

    if (rpm === null || rpm === undefined) {
        return;
    }

    if (rpm === 0) {
        throw new customError.RateLimitError(
            `Rule "${rule.name}" is unavailable (rpm = 0)`,
            RETRY_AFTER_SECONDS,
            failoverEligible,
            Number(rule.id),
            rule.name,
        );
    }

    const now = Date.now();
    const weighted = store.incr(`rule:${rule.id}:rpm`, now);
    // 超限（> 上限）才拒绝：rpm = N 表示滑动窗口内最多 N 个请求，第 N+1 个才拒绝
    if (weighted > rpm) {
        throw new customError.RateLimitError(
            `Rate limit exceeded for rule "${rule.name}" (rpm = ${rpm})`,
            RETRY_AFTER_SECONDS,
            failoverEligible,
            Number(rule.id),
            rule.name,
        );
    }
}

export default {
    checkAndAdmit,
    setStore,
};
