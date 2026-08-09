import type { SgModel } from "../../../model/sgModel";
import type { ModelRoutingResult } from "../types";
import type RoutingContext from "../routingContext";
import upstreamHealthService, { UpstreamHealthState } from "../../upstreamHealthService";

abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        candidates: ModelRoutingResult[],
        routingContext?: RoutingContext,
        seed?: number,
    ): ModelRoutingResult;

    // 判断单个上游是否本请求已试过，避免 failover 重试死循环（所有模式都需遵守，含 SINGLE）
    protected isTried(
        candidate: ModelRoutingResult,
        routingContext?: RoutingContext,
    ): boolean {
        if (!candidate.hasUpstream() || !routingContext) {
            return false;
        }
        return routingContext.hasTried(candidate.vendor.id, candidate.vendorModelName);
    }

    // 判断单个上游是否健康状态为 DOWN（冷却中）。
    // SINGLE 模式只有唯一固定上游、没有备用可切，不使用此判断，始终返回该上游
    protected isDown(
        candidate: ModelRoutingResult,
        now: number = Date.now(),
    ): boolean {
        if (!candidate.hasUpstream()) {
            return true;
        }
        const healthStatus = upstreamHealthService.getHealthStatus(
            candidate.vendor.id,
            candidate.vendorModelName,
            candidate.upstreamFormat,
            now,
        );
        return healthStatus.state === UpstreamHealthState.DOWN;
    }
}

export default BaseRoutingStrategy;
