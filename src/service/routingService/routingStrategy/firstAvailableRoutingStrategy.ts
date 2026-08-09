import type { SgModel } from "../../../model/sgModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";
import { ModelRoutingResult } from "../types";

class FirstAvailableRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult {
        // 过滤掉冷却中的上游，取配置顺序第一个可用
        return this.filterDownUpstreams(candidates)[0] ?? ModelRoutingResult.none();
    }
}

export default FirstAvailableRoutingStrategy;
