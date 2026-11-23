import type { SgModel } from "../../../model/sgModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";
import { ModelRoutingResult } from "../types";
import type RoutingContext from "../routingContext";

class FirstAvailableRoutingStrategy extends BaseRoutingStrategy {
    async selectUpstream(
        _model: SgModel,
        candidates: ModelRoutingResult[],
        routingContext?: RoutingContext,
    ): Promise<ModelRoutingResult> {
        // 逐个检查：跳过本请求已试过的与冷却中的上游，取配置顺序第一个可用。
        // 必须顺序 await（不能用 find + 异步谓词）：短路语义要保留，不能把所有候选的健康状态都查一遍
        for (const candidate of candidates) {
            if (this.isTried(candidate, routingContext)) {
                continue;
            }
            if (await this.isDown(candidate)) {
                continue;
            }
            return candidate;
        }
        return ModelRoutingResult.none();
    }
}

export default FirstAvailableRoutingStrategy;
