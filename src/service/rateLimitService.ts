import SgRule from "../model/sgRule";
import customError from "../customError";
import stateStoreService from "./stateStoreService";
import { StateStoreUnavailableError } from "../util/stateStore";
import type { RequestContext } from "../util/rule/types";

// rpm 的补液窗口：1 分钟（补液速率 = rpm / 60s）
const WINDOW_SECONDS = 60;
// rpm = 0（硬性阻断）时的重试建议：规则不可用，给出保守值供客户端退避
const RETRY_AFTER_OFFLINE_SECONDS = 60;
// Key 命名空间：限流 / 上游冷却 / 更新缓存共用同一个 StateStore 键空间，靠前缀隔离（方案 §2.1）
const RL_KEY_PREFIX = "rl:rule:";

/**
 * 限流计数器落在全局 `StateStore`（`stateStoreService.getStore()`）。
 *
 * 2026-11-16 Operator 决定（#287）：限流不用数据库。原先 Worker 走 D1 上的
 * `rate_limit_bucket` 表跨 isolate 共享（P0-2），该方案连同 migrate_0033 一并撤销。
 *
 * 现状与代价（与迁移前等价，不是本轮引入）：`memory` 后端是 **per-isolate** 的，
 * Worker 下每个 isolate 各有一份桶，N 个 isolate 下实际 rpm 上限约为 N × 配置值。
 * 这是有意接受的取舍 —— 限流是保护上游的软性措施；要跨 isolate 精确共享需换
 * `durable_object` / `redis` 后端（`src/util/stateStore/` 已留后端位，当前为空壳会抛错）。
 */

interface CheckAndAdmitOptions {
    /** 阶段二（供应商级限流）传 true：抛出的 RateLimitError 带 failover 标记，供路由循环识别换上游 */
    failoverEligible?: boolean;
}

/**
 * 限流准入：令牌桶消费 1 个令牌（补液 + 扣减一步完成），桶空抛 RateLimitError（429）。
 * - config.rpm 为 null / 缺省 → 不限制（规则命中但放行）
 * - config.rpm 为 0 → 不可用（无请求额度，所有命中请求一律 429，可作硬性阻断）
 * - config.rpm 为 N（N > 0）→ 令牌桶容量 N、补液 N 个/分钟：瞬时突发 ≤ N，
 *   长时间平均速率 = N 请求/分钟；桶空时按当前令牌数给出精确的 Retry-After
 *
 * 状态后端不可用（`StateStoreUnavailableError`）时 **fail-closed**：转成 429 拒绝放行，
 * 绝不因为「算不清额度」而放开限流（契约见 `src/util/stateStore/types.ts` 第 2 条）。
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
            RETRY_AFTER_OFFLINE_SECONDS,
            failoverEligible,
            Number(rule.id),
            rule.name,
        );
    }

    const key = `${RL_KEY_PREFIX}${rule.id}:rpm`;
    let result;
    try {
        result = await stateStoreService.getStore().consume(key, {
            capacity: rpm,
            refillPerSec: rpm / WINDOW_SECONDS,
            cost: 1,
        });
    } catch (err) {
        if (err instanceof StateStoreUnavailableError) {
            // fail-closed：状态后端算不出额度时宁可误拒，不可误放
            throw new customError.RateLimitError(
                `Rate limit store unavailable for rule "${rule.name}"`,
                RETRY_AFTER_OFFLINE_SECONDS,
                failoverEligible,
                Number(rule.id),
                rule.name,
            );
        }
        throw err;
    }

    if (!result.allowed) {
        // 精确重试时间由 StateStore 算好（retryAfterMs，向上取整到毫秒）；
        // null = 等多久都不会放行（refillPerSec <= 0 或 capacity < cost），给保守退避值
        const waitSeconds = result.retryAfterMs !== null
            ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
            : RETRY_AFTER_OFFLINE_SECONDS;
        throw new customError.RateLimitError(
            `Rate limit exceeded for rule "${rule.name}" (rpm = ${rpm})`,
            waitSeconds,
            failoverEligible,
            Number(rule.id),
            rule.name,
        );
    }
}

export default {
    checkAndAdmit,
};
