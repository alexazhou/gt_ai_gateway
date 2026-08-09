import { SgModel } from "../model/sgModel";
import { ApiFormat, PRICE_UNIT_TOKENS } from "../constants";
import { SgRecordUsage } from "../model/sgRecord";
import billingUtils from "./billingUtils";

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

    const recordUsage = new SgRecordUsage();
    let promptTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    if (format === ApiFormat.OPENAI) {
        promptTokens = (usage.prompt_tokens as number | undefined) ?? 0;
        outputTokens = (usage.completion_tokens as number | undefined) ?? 0;
        cacheReadTokens = ((usage.prompt_tokens_details as Dict | undefined)?.cached_tokens as number | undefined)
            ?? (usage.cache_read_tokens as number | undefined)
            ?? 0;
        recordUsage.prompt_tokens = Math.max(0, promptTokens - cacheReadTokens);
    }

    if (format === ApiFormat.ANTHROPIC) {
        promptTokens = ((usage.input_tokens as number | undefined) ?? 0) + ((usage.cache_read_input_tokens as number | undefined) ?? 0);
        outputTokens = (usage.output_tokens as number | undefined) ?? 0;
        cacheReadTokens = (usage.cache_read_input_tokens as number | undefined)
            ?? (usage.cache_read_tokens as number | undefined)
            ?? 0;
        recordUsage.prompt_tokens = (usage.input_tokens as number | undefined) ?? 0;
        recordUsage.cache_creation_tokens = (usage.cache_creation_input_tokens as number | undefined)
            ?? (usage.cache_creation_tokens as number | undefined);
    }

    if (format === ApiFormat.RESPONSES) {
        promptTokens = (usage.input_tokens as number | undefined)
            ?? (usage.prompt_tokens as number | undefined)
            ?? 0;
        outputTokens = (usage.output_tokens as number | undefined)
            ?? (usage.completion_tokens as number | undefined)
            ?? 0;
        cacheReadTokens = ((usage.input_tokens_details as Dict | undefined)?.cached_tokens as number | undefined)
            ?? ((usage.prompt_tokens_details as Dict | undefined)?.cached_tokens as number | undefined)
            ?? (usage.cache_read_input_tokens as number | undefined)
            ?? (usage.cache_read_tokens as number | undefined)
            ?? 0;
        recordUsage.prompt_tokens = Math.max(0, promptTokens - cacheReadTokens);
    }

    recordUsage.completion_tokens = outputTokens;
    recordUsage.cache_read_tokens = cacheReadTokens;
    return { recordUsage, promptTokens, outputTokens, cacheReadTokens };
}

export function buildStreamUsageAccounting(format: ApiFormat, usage: Dict | null | undefined, model: SgModel) {
    if (!usage) return { usageJson: null, cost: 0 };

    if (format === ApiFormat.OPENAI) {
        const normalizedUsage = normalizeUsage(ApiFormat.OPENAI, usage);
        const cost = normalizedUsage
            ? calculateCost(model, normalizedUsage.promptTokens, normalizedUsage.outputTokens, normalizedUsage.cacheReadTokens)
            : 0;

        return {
            usageJson: normalizedUsage ? JSON.stringify(normalizedUsage.recordUsage) : null,
            cost,
        };
    }

    const promptTokens = (usage.prompt_tokens as number | undefined) ?? 0;
    const outputTokens = (usage.completion_tokens as number | undefined) ?? 0;
    const cacheReadTokens = (usage.cache_read_tokens as number | undefined) ?? 0;
    const cost = calculateCost(model, promptTokens + cacheReadTokens, outputTokens, cacheReadTokens);

    return {
        usageJson: JSON.stringify(usage),
        cost,
    };
}

export default {
    calculateCost,
    normalizeUsage,
    buildStreamUsageAccounting,
};
