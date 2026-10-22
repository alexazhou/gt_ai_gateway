/**
 * Anthropic 请求的 `max_tokens` 缺省值（P1-07）。
 *
 * Anthropic Messages API 把 `max_tokens` 定为**必填**，所以 OpenAI 协议请求里没带
 * `max_tokens` / `max_completion_tokens` 时，转换层必须自己补一个。
 *
 * 原来补的是 32768：对小上限模型（如 max_tokens 上限 4096 的型号）会直接被上游
 * 400 打回，等于「客户端没传 → 请求必失败」。这里改成保守缺省，宁可少生成也不误报错；
 * 客户端显式传了值就以客户端为准（只做正整数校验，不做上限钳制 —— 具体上游上限
 * 只有上游自己知道，越权替它判断反而会掩盖真实的参数错误）。
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/**
 * 解析最终发给 Anthropic 的 max_tokens：
 * - 客户端传了正整数 → 原样使用（向下取整）
 * - 未传 / 非法值（0、负数、NaN、Infinity）→ `DEFAULT_ANTHROPIC_MAX_TOKENS`
 */
export function resolveAnthropicMaxTokens(requested: unknown): number {
    if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
        return Math.floor(requested);
    }
    return DEFAULT_ANTHROPIC_MAX_TOKENS;
}
