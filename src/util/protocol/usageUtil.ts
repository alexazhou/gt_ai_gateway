import { SgModel } from "../../model/sgModel";
import { ApiFormat, PRICE_UNIT_TOKENS } from "../../constants";
import { SgRecordUsage } from "../../model/sgRecord";
import billingUtils from "./billingUtil";

export type Dict = Record<string, unknown>;

export function calculateCost(
    model: SgModel,
    promptTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
): number {
    const prices = model.prices || {};
    const inputPrice = prices.input ?? 0;
    const cacheReadPrice = prices.cache_read ?? 0;
    const outputPrice = prices.output ?? 0;

    const normalPromptTokens = Math.max(0, promptTokens - cacheReadTokens);
    // 价格单位为每百万（PRICE_UNIT_TOKENS）token；结果取整到最小扣减单位（0.000001 元）的整数倍
    const promptCost = (normalPromptTokens / PRICE_UNIT_TOKENS) * inputPrice;
    const cacheCost = (cacheReadTokens / PRICE_UNIT_TOKENS) * cacheReadPrice;
    const outputCost = (outputTokens / PRICE_UNIT_TOKENS) * outputPrice;
    return billingUtils.quantizeAmount(promptCost + cacheCost + outputCost);
}

export function normalizeUsage(format: ApiFormat, usage: Dict | null | undefined) {
    if (!usage) return null;

    // 存储口径原始值（v2 总量口径），交由 SgRecordUsage 构造时统一归一为展示口径；
    // 计价用数字单独计算：缺失按 0 计费，落库字段保留「缺失 = null / 返回 0 = 0」的区分。
    let promptTotal: number | null = null;
    let completionRaw: number | null = null;
    let cacheReadRaw: number | null = null;
    let cacheWriteRaw: number | null = null;

    if (format === ApiFormat.OPENAI) {
        promptTotal = (usage.prompt_tokens as number | undefined) ?? null;
        completionRaw = (usage.completion_tokens as number | undefined) ?? null;
        cacheReadRaw = ((usage.prompt_tokens_details as Dict | undefined)?.cached_tokens as number | undefined)
            ?? (usage.cache_read_tokens as number | undefined)
            ?? null;
        // accumulator 归一化后 Anthropic 的 cache 写入以 cache_write_tokens 出现，统一键名落库
        cacheWriteRaw = (usage.cache_write_tokens as number | undefined) ?? null;
    }

    if (format === ApiFormat.ANTHROPIC) {
        const inputRaw = usage.input_tokens as number | undefined;
        const cacheBase = (usage.cache_read_input_tokens as number | undefined)
            ?? (usage.cache_read_tokens as number | undefined);
        // Anthropic input_tokens 不含缓存命中，总量 = input_tokens + cache_read_input_tokens
        promptTotal = inputRaw != null ? (inputRaw + (cacheBase ?? 0)) : null;
        completionRaw = (usage.output_tokens as number | undefined) ?? null;
        cacheReadRaw = cacheBase ?? null;
        cacheWriteRaw = (usage.cache_creation_input_tokens as number | undefined)
            ?? (usage.cache_creation_tokens as number | undefined)
            ?? null;
    }

    if (format === ApiFormat.RESPONSES) {
        promptTotal = (usage.input_tokens as number | undefined)
            ?? (usage.prompt_tokens as number | undefined)
            ?? null;
        completionRaw = (usage.output_tokens as number | undefined)
            ?? (usage.completion_tokens as number | undefined)
            ?? null;
        cacheReadRaw = ((usage.input_tokens_details as Dict | undefined)?.cached_tokens as number | undefined)
            ?? ((usage.prompt_tokens_details as Dict | undefined)?.cached_tokens as number | undefined)
            ?? (usage.cache_read_input_tokens as number | undefined)
            ?? (usage.cache_read_tokens as number | undefined)
            ?? null;
    }

    const promptTokens = promptTotal ?? 0;
    const outputTokens = completionRaw ?? 0;
    const cacheReadTokens = cacheReadRaw ?? 0;

    // 构造即归一：SgRecordUsage 实例内部为展示口径（prompt_tokens = 非缓存输入）
    const recordUsage = new SgRecordUsage({
        version: 2,
        prompt_tokens: promptTotal,
        completion_tokens: completionRaw,
        cache_read_tokens: cacheReadRaw,
        cache_creation_tokens: cacheWriteRaw,
    });

    return { recordUsage, promptTokens, outputTokens, cacheReadTokens };
}


/**
 * 把规整后的 recordUsage 序列化为落库存储串（v2 总量口径 + usage_version 标记）。
 * 写侧统一走这里（裸 query().update() 不走模型 cast，不能依赖 SgRecordUsage.set()）。
 */
export function serializeStoredUsage(recordUsage: SgRecordUsage | null | undefined): string | null {
    if (!recordUsage) return null;
    return JSON.stringify(recordUsage.toStorageJSON());
}

export default {
    calculateCost,
    normalizeUsage,
    serializeStoredUsage,
};
