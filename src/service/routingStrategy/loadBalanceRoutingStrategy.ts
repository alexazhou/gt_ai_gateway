import type { SgModel } from "../../model/sgModel";
import BaseRoutingStrategy, { type ModelRoutingResult } from "./baseRoutingStrategy";

class LoadBalanceRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult | null {
        if (candidates.length === 0) {
            return null;
        }

        return candidates[Math.floor(Math.random() * candidates.length)];
    }
}

export default LoadBalanceRoutingStrategy;
