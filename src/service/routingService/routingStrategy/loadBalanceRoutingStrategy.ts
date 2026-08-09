import type { SgModel } from "../../../model/sgModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";
import { ModelRoutingResult } from "../types";

class LoadBalanceRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult {
        const available = this.filterDownUpstreams(candidates);
        if (available.length === 0) {
            return ModelRoutingResult.none();
        }

        return available[Math.floor(Math.random() * available.length)];
    }
}

export default LoadBalanceRoutingStrategy;
