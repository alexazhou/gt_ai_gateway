import type { SgModel } from "../../model/sgModel";
import BaseRoutingStrategy, { ModelRoutingResult } from "./baseRoutingStrategy";

class SingleRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult {
        return candidates[0] ?? ModelRoutingResult.none();
    }
}

export default SingleRoutingStrategy;
