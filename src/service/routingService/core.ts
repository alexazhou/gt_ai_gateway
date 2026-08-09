import {
    ApiFormat,
    ModelRoutingMode,
    RETRYABLE_UPSTREAM_STATUS_CODES,
} from "../../constants";
import { SgModel } from "../../model/sgModel";
import { SgVendor } from "../../model/sgVendor";
import { SgVendorModel } from "../../model/sgVendorModel";
import customError from "../../util/customError";
import protocolUtils from "../../util/protocolUtils";
import upstreamHealthService, { UpstreamHealthState } from "../upstreamHealthService";
import RoutingContext from "./routingContext";
import { ModelRoutingResult } from "./types";
import BaseRoutingStrategy from "./routingStrategy/baseRoutingStrategy";
import FirstAvailableRoutingStrategy from "./routingStrategy/firstAvailableRoutingStrategy";
import LoadBalanceRoutingStrategy from "./routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "./routingStrategy/singleRoutingStrategy";

const strategies: Record<ModelRoutingMode, BaseRoutingStrategy> = {
    [ModelRoutingMode.SINGLE]: new SingleRoutingStrategy(),
    [ModelRoutingMode.LOAD_BALANCE]: new LoadBalanceRoutingStrategy(),
    [ModelRoutingMode.FIRST_AVAILABLE]: new FirstAvailableRoutingStrategy(),
};


async function validateConfig(
    model: SgModel,
): Promise<void> {
    if (typeof model.name !== "string" || !model.name.trim()) {
        throw new customError.AppError("Model name is required");
    }

    if (!Object.values(ModelRoutingMode).includes(model.routing_mode)) {
        throw new customError.AppError("Invalid routing mode");
    }

    const mode = model.routing_mode;
    const upstreams = model.getRoutingConfig().upstreams;
    for (const upstream of upstreams) {
        if (!Number.isInteger(upstream.vendor_id) || upstream.vendor_id <= 0) {
            throw new customError.AppError("Each upstream must specify a valid vendor_id");
        }
        if (
            upstream.vendor_model_id !== undefined
            && (!Number.isInteger(upstream.vendor_model_id) || upstream.vendor_model_id <= 0)
        ) {
            throw new customError.AppError("vendor_model_id must be a positive integer");
        }
        if (typeof upstream.enabled !== "boolean") {
            throw new customError.AppError("enabled must be a boolean");
        }
    }

    const enabledUpstreams = upstreams.filter(upstream => upstream.enabled);
    if (enabledUpstreams.length === 0) {
        throw new customError.AppError("At least one upstream must be enabled");
    }
    if (mode === ModelRoutingMode.SINGLE && enabledUpstreams.length !== 1) {
        throw new customError.AppError("Single routing mode requires exactly one enabled upstream");
    }

    const routeKeys = new Set<string>();
    for (const upstream of enabledUpstreams) {
        const routeKey = `${upstream.vendor_id}:${upstream.vendor_model_id ?? model.name}`;
        if (routeKeys.has(routeKey)) {
            throw new customError.AppError("Duplicate enabled upstream");
        }
        routeKeys.add(routeKey);
    }

    for (const upstream of upstreams) {
        const vendor = await SgVendor.query().find(upstream.vendor_id);
        if (!vendor) {
            throw new customError.NotFoundError("Vendor not found");
        }

        if (upstream.vendor_model_id) {
            const vendorModel = await SgVendorModel.query().find(upstream.vendor_model_id);
            if (!vendorModel) {
                throw new customError.NotFoundError("Vendor model not found");
            }
            if (vendorModel.vendor_id !== upstream.vendor_id) {
                throw new customError.AppError("Vendor model does not belong to the selected vendor");
            }
        } else if (mode === ModelRoutingMode.FIRST_AVAILABLE && upstream.enabled) {
            const vendorModel = await SgVendorModel.query()
                .where("vendor_id", upstream.vendor_id)
                .where("model_id", model.name)
                .first();
            if (!vendorModel) {
                throw new customError.AppError(
                    `Vendor ${upstream.vendor_id} does not have model ${model.name}`,
                );
            }
        }
    }
}


async function resolveAvailableCandidates(
    model: SgModel,
    clientFormat: ApiFormat,
    routingContext: RoutingContext,
    now: number,
): Promise<ModelRoutingResult[]> {
    const upstreams = model.getRoutingConfig().upstreams.filter(upstream => upstream.enabled);
    if (upstreams.length === 0) {
        throw new customError.AppError(`No enabled upstream for model ${model.name}`, 503);
    }

    const candidates: ModelRoutingResult[] = [];
    for (const upstream of upstreams) {
        const vendor = await SgVendor.query().find(upstream.vendor_id);
        if (!vendor) {
            continue;
        }

        let vendorModel = upstream.vendor_model_id
            ? await SgVendorModel.query().find(upstream.vendor_model_id)
            : null;
        if (upstream.vendor_model_id && !vendorModel) {
            continue;
        }
        if (!upstream.vendor_model_id && model.routing_mode !== ModelRoutingMode.LOAD_BALANCE) {
            vendorModel = await SgVendorModel.query()
                .where("vendor_id", upstream.vendor_id)
                .where("model_id", model.name)
                .first();
        }
        if (vendorModel && vendorModel.vendor_id !== upstream.vendor_id) {
            continue;
        }

        if (!vendorModel && !upstream.vendor_model_id && model.routing_mode !== ModelRoutingMode.LOAD_BALANCE && model.name) {
            vendorModel = await SgVendorModel.query().create({
                vendor_id: upstream.vendor_id,
                model_id: model.name,
            });
        }

        let supportedFormats: ApiFormat[];
        let upstreamFormat: ApiFormat;
        try {
            supportedFormats = vendorModel?.getSupportedFormats() ?? vendor.getSupportedFormats();
            upstreamFormat = protocolUtils.resolveUpstreamFormat(clientFormat, supportedFormats);
            vendor.getUrlByFormat(upstreamFormat);
        } catch {
            continue;
        }

        // 自动上游（无 vendor_model_id）同样参与冷却：key 使用模型名
        const vendorModelName = vendorModel?.model_id ?? model.name ?? "";

        // 本次请求已用过的后端，跳过，避免重试循环
        if (routingContext.hasTried(upstream.vendor_id, vendorModelName)) {
            continue;
        }

        const healthStatus = upstreamHealthService.getHealthStatus(
            upstream.vendor_id,
            vendorModelName,
            upstreamFormat,
            now,
        );
        if (healthStatus.state === UpstreamHealthState.DOWN) {
            continue;
        }

        candidates.push(
            new ModelRoutingResult(vendor, vendorModelName, supportedFormats),
        );
    }

    return candidates;
}


async function selectUpstream(
    model: SgModel,
    clientFormat: ApiFormat,
    routingContext: RoutingContext,
    now: number = Date.now(),
): Promise<ModelRoutingResult> {
    const strategy = strategies[model.routing_mode];
    if (!strategy) {
        throw new customError.AppError("Invalid routing mode");
    }

    const candidates = await resolveAvailableCandidates(model, clientFormat, routingContext, now);
    const selected = strategy.selectUpstream(model, candidates);
    // 记录本次已选后端，后续重试不再选中（成功则循环立即结束，该记录无害）
    if (selected.hasUpstream()) {
        routingContext.markTried(selected.vendor.id, selected.vendorModelName);
    }
    // 选中的 candidate 本身就是路由结果；无可用上游时返回上游为 null 的空结果，由调用方判断
    return selected;
}


function isRetryableStatus(status: number): boolean {
    return RETRYABLE_UPSTREAM_STATUS_CODES.includes(status);
}


export { ModelRoutingResult };
export default {
    validateConfig,
    selectUpstream,
    isRetryableStatus,
};
