import type { SgModel } from "../../../model/sgModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";
import { ModelRoutingResult } from "../types";
import type RoutingContext from "../routingContext";

class FirstAvailableRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
        routingContext?: RoutingContext,
    ): ModelRoutingResult {
        // 逐个检查：跳过本请求已试过的与冷却中的上游，取配置顺序第一个可用
        return candidates.find(candidate =>
            !this.isTried(candidate, routingContext) && !this.isDown(candidate),
        ) ?? ModelRoutingResult.none();
    }
}

export default FirstAvailableRoutingStrategy;
