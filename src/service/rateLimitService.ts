import SgRule from "../model/sgRule";
import customError from "../customError";
import memoryRateLimitStore from "../util/rule/memoryRateLimitStore";
import type { RateLimitStore, RequestContext } from "../util/rule/types";

// rpm 的补液窗口：1 分钟（补液速率 = rpm / 60s）
const WINDOW_MS = 60_000;
// rpm = 0（硬性阻断）时的重试建议：规则不可用，给出保守值供客户端退避
const RETRY_AFTER_OFFLINE_SECONDS = 60;

// 注入的计数器存储实现（测试可替换）
let storeOverride: RateLimitStore | null = null;

/**
 * 解析当前应使用的限流存储：**一律内存令牌桶**。
 *
 * 2026-11-16 Operator 决定（#287）：限流不用数据库。原先 Worker 走 D1 上的
 * `rate_limit_bucket` 表以跨 isolate 共享（P0-2），该方案连同 migrate_0033 一并撤销。
 *
 * 代价要说清：Worker 每个 isolate 各有一份桶，N 个 isolate 下实际 rpm 上限约为
 * N × 配置值。这是有意接受的取舍 —— 限流是保护上游的软性措施，不值得为它维护一张
 * 只在 Worker 路径读写的表；需要精确全局配额时应改 Durable Object / Redis
 * （`src/util/stateStore/` 已留 `durable_object` / `redis` 后端位，实现为空壳会抛错）。
 */
function resolveStore(): RateLimitStore {
    return storeOverride ?? memoryRateLimitStore;
}

function setStore(implementation: RateLimitStore | null): void {
    storeOverride = implementation;
}

interface CheckAndAdmitOptions {
    /** 阶段二（供应商级限流）传 true：抛出的 RateLimitError 带 failover 标记，供路由循环识别换上游 */
    failoverEligible?: boolean;
}

/** 由 rpm 推导令牌桶参数：容量 = rpm（瞬时突发上限），补液速率 = rpm / 60s */
function tokenBucketParams(rpm: number): { capacity: number; refillPerMs: number } {
    return { capacity: rpm, refillPerMs: rpm / WINDOW_MS };
}

/**
 * 限流准入：令牌桶消费 1 个令牌（补液 + 扣减一步完成），桶空抛 RateLimitError（429）。
 * - config.rpm 为 null / 缺省 → 不限制（规则命中但放行）
 * - config.rpm 为 0 → 不可用（无请求额度，所有命中请求一律 429，可作硬性阻断）
 * - config.rpm 为 N（N > 0）→ 令牌桶容量 N、补液 N 个/分钟：瞬时突发 ≤ N，
 *   长时间平均速率 = N 请求/分钟；桶空时按当前令牌数给出精确的 Retry-After
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

    const now = Date.now();
    const { capacity, refillPerMs } = tokenBucketParams(rpm);
    // consume 可能是异步实现，await 对同步实现同样安全
    const result = await resolveStore().consume(`rule:${rule.id}:rpm`, now, capacity, refillPerMs);
    if (!result.allowed) {
        // 精确重试时间：补足 (1 - remaining) 个令牌所需毫秒，换算成秒向上取整（最小 1s）
        const waitSeconds = Math.max(1, Math.ceil((1 - result.remaining) / refillPerMs / 1000));
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
    setStore,
};