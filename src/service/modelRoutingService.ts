import {
    ApiFormat,
    ModelRoutingMode,
    RETRYABLE_UPSTREAM_STATUS_CODES,
    UPSTREAM_FAILURE_COOLDOWN_MS,
} from "../constants";
import { ModelRoutingConfig, ModelUpstreamConfig, SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";
import { SgVendorModel } from "../model/sgVendorModel";
import customError from "../util/customError";
import protocolUtils from "../util/protocolUtils";
import BaseRoutingStrategy, { type RoutingCandidate } from "./routingStrategy/baseRoutingStrategy";
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


function normalizeMode(mode: unknown): ModelRoutingMode {
    if (Object.values(ModelRoutingMode).includes(mode as ModelRoutingMode)) {
        return mode as ModelRoutingMode;
    }

    throw new customError.AppError("Invalid routing mode");
}


function normalizeUpstream(value: unknown): ModelUpstreamConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new customError.AppError("Invalid upstream configuration");
    }

    const raw = value as Record<string, unknown>;
    const vendorId = Number(raw.vendor_id);
    if (!Number.isInteger(vendorId) || vendorId <= 0) {
        throw new customError.AppError("Each upstream must specify a valid vendor_id");
    }

    const upstream = new ModelUpstreamConfig({
        vendor_id: vendorId,
        enabled: raw.enabled !== false,
    });

    if (raw.vendor_model_id !== undefined && raw.vendor_model_id !== null) {
        const vendorModelId = Number(raw.vendor_model_id);
        if (!Number.isInteger(vendorModelId) || vendorModelId <= 0) {
            throw new customError.AppError("vendor_model_id must be a positive integer");
        }
        upstream.vendor_model_id = vendorModelId;
    }

    return upstream;
}


async function validateConfig(
    modelName: string,
    modeValue: unknown,
    configValue: unknown,
): Promise<{ mode: ModelRoutingMode; config: ModelRoutingConfig }> {
    const mode = normalizeMode(modeValue);
    if (!configValue || typeof configValue !== "object" || Array.isArray(configValue)) {
        throw new customError.AppError("routing_config must be an object");
    }

    const rawUpstreams = (configValue as Record<string, unknown>).upstreams;
    if (!Array.isArray(rawUpstreams)) {
        throw new customError.AppError("routing_config.upstreams must be an array");
    }

    const upstreams = rawUpstreams.map(normalizeUpstream);
    const enabledUpstreams = upstreams.filter(upstream => upstream.enabled);
    if (enabledUpstreams.length === 0) {
        throw new customError.AppError("At least one upstream must be enabled");
    }
    if (mode === ModelRoutingMode.SINGLE && enabledUpstreams.length !== 1) {
        throw new customError.AppError("Single routing mode requires exactly one enabled upstream");
    }

    const routeKeys = new Set<string>();
    for (const upstream of enabledUpstreams) {
        const routeKey = `${upstream.vendor_id}:${upstream.vendor_model_id ?? modelName}`;
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
                .where("model_id", modelName)
                .first();
            if (!vendorModel) {
                throw new customError.AppError(
                    `Vendor ${upstream.vendor_id} does not have model ${modelName}`,
                );
            }
        }
    }

    return { mode, config: new ModelRoutingConfig({ upstreams }) };
}


async function resolveCandidates(
    model: SgModel,
    clientFormat: ApiFormat,
): Promise<RoutingCandidate[]> {
    const upstreams = model.getRoutingConfig().upstreams.filter(upstream => upstream.enabled);
    if (upstreams.length === 0) {
        throw new customError.AppError(`No enabled upstream for model ${model.name}`, 503);
    }

    const candidates: RoutingCandidate[] = [];
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

        candidates.push({
            vendorModel,
            upstreamFormat,
        });
    }

    return candidates;
}


function isCoolingDown(candidate: RoutingCandidate, now: number): boolean {
    const lastFailureAt = candidate.vendorModel
        ?.getHealth()
        .getLastFailureAt(candidate.upstreamFormat);
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
    const mode = Object.values(ModelRoutingMode).includes(model.routing_mode)
        ? model.routing_mode
        : ModelRoutingMode.SINGLE;
    const candidates = await resolveCandidates(model, clientFormat);
    const availableCandidates = candidates.filter(candidate => !isCoolingDown(candidate, now));
    const selected = strategies[mode].selectUpstream(model, availableCandidates);
    return selected ? new ModelRoutingResult(selected.vendorModel.id) : null;
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
