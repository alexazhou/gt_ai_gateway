import type { SgModel } from "../../model/sgModel";
import BaseRoutingStrategy, { type ModelRoutingResult } from "./baseRoutingStrategy";

class FirstAvailableRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult | null {
        return candidates[0] ?? null;
    }
}

export default FirstAvailableRoutingStrategy;
