import type { SgModel } from "../../../model/sgModel";
import type { ModelRoutingResult } from "../types";

abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult;
}

export default BaseRoutingStrategy;
