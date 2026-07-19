import type { SgModel } from "../../model/sgModel";
import BaseRoutingStrategy, { type RoutingCandidate } from "./baseRoutingStrategy";

class FailoverRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: RoutingCandidate[],
    ): RoutingCandidate | null {
        return candidates[0] ?? null;
    }
}

export default FailoverRoutingStrategy;
