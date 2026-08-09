import type { SgModel } from "../../../model/sgModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";
import { ModelRoutingResult } from "../types";
import type RoutingContext from "../routingContext";

class SingleRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
        routingContext?: RoutingContext,
    ): ModelRoutingResult {
        // SINGLE 模式只有唯一固定上游，忽略健康状态，但跳过本请求已试过的（避免 failover 死循环）
        return candidates.find(candidate => !this.isTried(candidate, routingContext))
            ?? ModelRoutingResult.none();
    }
}

export default SingleRoutingStrategy;
