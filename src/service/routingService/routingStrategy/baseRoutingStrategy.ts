import type { SgModel } from "../../../model/sgModel";
import type { ModelRoutingResult } from "../types";
import upstreamHealthService, { UpstreamHealthState } from "../../upstreamHealthService";

abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult;

    // 过滤掉健康状态为 DOWN（冷却中）的上游。
    // SINGLE 模式只有唯一固定上游、没有备用可切，不使用此过滤，始终返回该上游
    protected filterDownUpstreams(
        candidates: ModelRoutingResult[],
        now: number = Date.now(),
    ): ModelRoutingResult[] {
        return candidates.filter(candidate => {
            if (!candidate.hasUpstream()) {
                return false;
            }
            const healthStatus = upstreamHealthService.getHealthStatus(
                candidate.vendor.id,
                candidate.vendorModelName,
                candidate.upstreamFormat,
                now,
            );
            return healthStatus.state !== UpstreamHealthState.DOWN;
        });
    }
}

export default BaseRoutingStrategy;
