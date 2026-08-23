import type { Context } from "hono";
import { ApiFormat, ModelRoutingMode } from "../../constants";
import { SgModel } from "../../model/sgModel";
import vendorManager from "../../manager/vendorManager";
import vendorModelManager from "../../manager/vendorModelManager";
import customError from "../../customError";
import protocolUtils from "../../util/protocol/protocolUtil";
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
        const vendor = await vendorManager.findById(upstream.vendor_id);
        if (!vendor) {
            throw new customError.NotFoundError("Vendor not found");
        }

        if (upstream.vendor_model_id) {
            const vendorModel = await vendorModelManager.findById(upstream.vendor_model_id);
            if (!vendorModel) {
                throw new customError.NotFoundError("Vendor model not found");
            }
            if (vendorModel.vendor_id !== upstream.vendor_id) {
                throw new customError.AppError("Vendor model does not belong to the selected vendor");
            }
        } else if (mode === ModelRoutingMode.FIRST_AVAILABLE && upstream.enabled) {
            const vendorModel = await vendorModelManager.findByVendorAndModel(upstream.vendor_id, model.name);
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
): Promise<ModelRoutingResult[]> {
    const upstreams = model.getRoutingConfig().upstreams.filter(upstream => upstream.enabled);
    if (upstreams.length === 0) {
        throw new customError.AppError(`No enabled upstream for model ${model.name}`, 503);
    }

    const candidates: ModelRoutingResult[] = [];
    for (const upstream of upstreams) {
        const vendor = await vendorManager.findById(upstream.vendor_id);
        if (!vendor) {
            continue;
        }

        let vendorModel = upstream.vendor_model_id
            ? await vendorModelManager.findById(upstream.vendor_model_id)
            : null;
        if (upstream.vendor_model_id && !vendorModel) {
            continue;
        }
        if (!upstream.vendor_model_id && model.routing_mode !== ModelRoutingMode.LOAD_BALANCE) {
            vendorModel = await vendorModelManager.findByVendorAndModel(upstream.vendor_id, model.name);
        }
        if (vendorModel && vendorModel.vendor_id !== upstream.vendor_id) {
            continue;
        }

        if (!vendorModel && !upstream.vendor_model_id && model.routing_mode !== ModelRoutingMode.LOAD_BALANCE && model.name) {
            vendorModel = await vendorModelManager.create(upstream.vendor_id, model.name);
        }

        let supportedFormats: ApiFormat[];
        let upstreamFormat: ApiFormat;
        try {
            supportedFormats = vendorModel?.getSupportedFormats() ?? vendor.getSupportedFormats();
            upstreamFormat = protocolUtils.resolveUpstreamFormat(clientFormat, supportedFormats);
            // 解析不出该格式的 URL（缺 URL 或无法派生）时，该候选不可用
            if (vendor.getUrlByFormat(upstreamFormat) === null) {
                continue;
            }
        } catch {
            continue;
        }

        // 自动上游（无 vendor_model_id）同样参与冷却：key 使用模型名
        const vendorModelName = vendorModel?.model_id ?? model.name ?? "";

        // 健康状态与"本请求已试过"的过滤已下沉到各策略类
        candidates.push(
            new ModelRoutingResult(vendor, vendorModelName, upstreamFormat),
        );
    }

    return candidates;
}


async function selectUpstream(
    model: SgModel,
    clientFormat: ApiFormat,
    routingContext: RoutingContext,
    c?: Context,
): Promise<ModelRoutingResult> {
    const strategy = strategies[model.routing_mode];
    if (!strategy) {
        throw new customError.AppError("Invalid routing mode");
    }

    const candidates = await resolveAvailableCandidates(model, clientFormat);
    // 负载均衡"按用户随机"模式的种子：从请求 context 读取用户 id，调用方无需主动传入
    const seed = (c?.get("user") as { id?: number } | undefined)?.id;
    const selected = strategy.selectUpstream(model, candidates, routingContext, seed);
    // 记录本次已选后端，后续重试不再选中（成功则循环立即结束，该记录无害）
    if (selected.hasUpstream()) {
        routingContext.markTried(selected.vendor.id, selected.vendorModelName);
    }
    // 选中的 candidate 本身就是路由结果；无可用上游时返回上游为 null 的空结果，由调用方判断
    return selected;
}


export { ModelRoutingResult };
export default {
    validateConfig,
    selectUpstream,
};
