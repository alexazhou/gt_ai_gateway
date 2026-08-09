import type { SgModel } from "../../../model/sgModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";
import { ModelRoutingResult } from "../types";
import type RoutingContext from "../routingContext";


// mulberry32：可复现的伪随机数生成器（整数种子）
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


// 以种子做确定性 Fisher-Yates 乱序（同一种子 → 同一顺序）
function seededShuffle<T>(items: T[], seed: number): T[] {
    const arr = [...items];
    const rand = mulberry32(seed);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}


class LoadBalanceRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        model: SgModel,
        candidates: ModelRoutingResult[],
        routingContext?: RoutingContext,
        seed: number = 0,
    ): ModelRoutingResult {
        const untried = candidates.filter(candidate => !this.isTried(candidate, routingContext));

        // 按请求随机：等概率随机选一个可用上游（保持原行为）
        if (model.getRoutingConfig().load_balance_strategy === "request") {
            const available = untried.filter(candidate => !this.isDown(candidate));
            if (available.length === 0) {
                return ModelRoutingResult.none();
            }
            return available[Math.floor(Math.random() * available.length)];
        }

        // 按用户随机（默认）：以用户 id 为种子确定性乱序，
        // 逐个跳过冷却中的上游，取第一个可用
        const shuffled = seededShuffle(untried, seed);
        return shuffled.find(candidate => !this.isDown(candidate)) ?? ModelRoutingResult.none();
    }
}

export default LoadBalanceRoutingStrategy;
