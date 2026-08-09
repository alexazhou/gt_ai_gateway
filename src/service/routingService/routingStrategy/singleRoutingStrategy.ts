import type { SgModel } from "../../../model/sgModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";
import { ModelRoutingResult } from "../types";

class SingleRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult {
        // SINGLE 模式只有唯一固定上游，忽略健康状态直接返回该上游
        return candidates[0] ?? ModelRoutingResult.none();
    }
}

export default SingleRoutingStrategy;
