import type { SgModel } from "../../model/sgModel";
import BaseRoutingStrategy, { ModelRoutingResult } from "./baseRoutingStrategy";

class LoadBalanceRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult {
        if (candidates.length === 0) {
            return ModelRoutingResult.none();
        }

        return candidates[Math.floor(Math.random() * candidates.length)];
    }
}

export default LoadBalanceRoutingStrategy;
