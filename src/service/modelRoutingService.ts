import {
    ApiFormat,
    ModelRoutingMode,
    RETRYABLE_UPSTREAM_STATUS_CODES,
    UPSTREAM_FAILURE_COOLDOWN_MS,
} from "../constants";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";
import { SgVendorModel } from "../model/sgVendorModel";
import customError from "../util/customError";
import protocolUtils from "../util/protocolUtils";
import BaseRoutingStrategy from "./routingStrategy/baseRoutingStrategy";
import FailoverRoutingStrategy from "./routingStrategy/failoverRoutingStrategy";
import LoadBalanceRoutingStrategy from "./routingStrategy/loadBalanceRoutingStrategy";
import SingleRoutingStrategy from "./routingStrategy/singleRoutingStrategy";

class ModelRoutingResult {
    constructor(readonly vendorModelId: number) {}
}

const strategies: Record<ModelRoutingMode, BaseRoutingStrategy> = {
    [ModelRoutingMode.SINGLE]: new SingleRoutingStrategy(),
    [ModelRoutingMode.LOAD_BALANCE]: new LoadBalanceRoutingStrategy(),
    [ModelRoutingMode.FAILOVER]: new FailoverRoutingStrategy(),
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
        } else if (mode !== ModelRoutingMode.SINGLE && upstream.enabled) {
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


async function resolveAvailableVendorModels(
    model: SgModel,
    clientFormat: ApiFormat,
    now: number,
): Promise<SgVendorModel[]> {
    const upstreams = model.getRoutingConfig().upstreams.filter(upstream => upstream.enabled);
    if (upstreams.length === 0) {
        throw new customError.AppError(`No enabled upstream for model ${model.name}`, 503);
    }

    const vendorModels: SgVendorModel[] = [];
    for (const upstream of upstreams) {
        const vendor = await SgVendor.query().find(upstream.vendor_id);
        if (!vendor) {
            continue;
        }

        let vendorModel = upstream.vendor_model_id
            ? await SgVendorModel.query().find(upstream.vendor_model_id)
            : await SgVendorModel.query()
                .where("vendor_id", upstream.vendor_id)
                .where("model_id", model.name)
                .first();
        if (upstream.vendor_model_id && !vendorModel) {
            continue;
        }
        if (vendorModel && vendorModel.vendor_id !== upstream.vendor_id) {
            continue;
        }

        if (!vendorModel && !upstream.vendor_model_id && model.name) {
            vendorModel = await SgVendorModel.query().create({
                vendor_id: upstream.vendor_id,
                model_id: model.name,
            });
        }
        if (!vendorModel) {
            throw new customError.AppError("Upstream model name is missing", 503);
        }

        let upstreamFormat: ApiFormat;
        try {
            const supportedFormats = vendorModel.getSupportedFormats() ?? vendor.getSupportedFormats();
            upstreamFormat = protocolUtils.resolveUpstreamFormat(clientFormat, supportedFormats);
            vendor.getUrlByFormat(upstreamFormat);
        } catch {
            continue;
        }

        if (!isCoolingDown(vendorModel, upstreamFormat, now)) {
            vendorModels.push(vendorModel);
        }
    }

    return vendorModels;
}


function isCoolingDown(
    vendorModel: SgVendorModel,
    upstreamFormat: ApiFormat,
    now: number,
): boolean {
    const lastFailureAt = vendorModel.getHealth().getLastFailureAt(upstreamFormat);
    if (!lastFailureAt) {
        return false;
    }

    const failedAt = Date.parse(lastFailureAt);
    return Number.isFinite(failedAt) && now - failedAt < UPSTREAM_FAILURE_COOLDOWN_MS;
}


async function selectUpstream(
    model: SgModel,
    clientFormat: ApiFormat,
    now: number = Date.now(),
): Promise<ModelRoutingResult | null> {
    const vendorModels = await resolveAvailableVendorModels(model, clientFormat, now);
    const selected = strategies[model.routing_mode].selectUpstream(model, vendorModels);
    return selected ? new ModelRoutingResult(selected.id) : null;
}


async function markFailure(
    result: ModelRoutingResult,
    upstreamFormat: ApiFormat,
    failedAt: Date = new Date(),
): Promise<boolean> {
    const vendorModel = await SgVendorModel.query().find(result.vendorModelId);
    if (!vendorModel) {
        return false;
    }

    const health = vendorModel.getHealth();
    health.recordFailure(upstreamFormat, failedAt);
    vendorModel.health = health;
    await SgVendorModel.query()
        .where("id", vendorModel.id)
        .update({ health: JSON.stringify(health) });
    return true;
}


function isRetryableStatus(status: number): boolean {
    return RETRYABLE_UPSTREAM_STATUS_CODES.includes(status);
}


export { ModelRoutingResult };
export default {
    validateConfig,
    selectUpstream,
    markFailure,
    isRetryableStatus,
};
