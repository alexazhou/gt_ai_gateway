import type { Context } from "hono";
import { ApiFormat, ModelRoutingMode } from "../../constants";
import { SgModel } from "../../model/sgModel";
import vendorManager from "../../manager/vendorManager";
import vendorModelManager from "../../manager/vendorModelManager";
import customError from "../../customError";
import protocolUtils from "../../util/protocolUtil/protocolUtil";
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


/**
 * 配置写入时补建 vendor_model（原实现放在选路读路径里，见 P1-10）。
 *
 * 语义：非负载均衡模式下，上游没指定 vendor_model_id 时按「模型名」绑定到该 vendor，
 * 缺失就建一条。补建属于「配置变更」而不是「请求副作用」——所以挪到 model 创建/更新时做，
 * 请求路径变成纯读，不会在用户请求里写库（D1 上是每次请求 1 次写，且并发下会撞主键）。
 *
 * 返回补建的 vendor_model 数量，方便调用方/日志观察。
 */
async function ensureVendorModels(model: SgModel, tenantId?: number): Promise<number> {
    if (model.routing_mode === ModelRoutingMode.LOAD_BALANCE) {
        return 0;
    }
    const modelName = model.name;
    if (!modelName) {
        return 0;
    }

    let created = 0;
    for (const upstream of model.getRoutingConfig().upstreams) {
        if (!upstream.enabled || upstream.vendor_model_id) {
            continue;
        }
        if (tenantId !== undefined) {
            const vendor = await vendorManager.findById(upstream.vendor_id);
            // vendor 不存在 / 跨租户 → 交给 validateConfig 报错，这里不写脏数据
            if (!vendor || vendor.tenant_id !== tenantId) {
                continue;
            }
        }
        const existing = await vendorModelManager.findByVendorAndModel(upstream.vendor_id, modelName);
        if (!existing) {
            await vendorModelManager.create(upstream.vendor_id, modelName);
            created += 1;
        }
    }
    return created;
}


async function validateConfig(
    model: SgModel,
    tenantId?: number,
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

        // 同租户校验：模型上游 vendor 必须属于模型归属租户（共享模型的上游则必须属于 main）
        if (tenantId !== undefined && vendor.tenant_id !== tenantId) {
            throw new customError.AppError(
                `Vendor ${upstream.vendor_id} does not belong to the model's tenant`,
                400,
            );
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
    const skipped: string[] = [];
    for (const upstream of upstreams) {
        const vendor = await vendorManager.findById(upstream.vendor_id);
        if (!vendor) {
            skipped.push(`vendor ${upstream.vendor_id} not found`);
            continue;
        }

        let vendorModel = upstream.vendor_model_id
            ? await vendorModelManager.findById(upstream.vendor_model_id)
            : null;
        if (upstream.vendor_model_id && !vendorModel) {
            skipped.push(`vendor ${upstream.vendor_id}: vendor model ${upstream.vendor_model_id} not found`);
            continue;
        }
        if (!upstream.vendor_model_id && model.routing_mode !== ModelRoutingMode.LOAD_BALANCE) {
            vendorModel = await vendorModelManager.findByVendorAndModel(upstream.vendor_id, model.name);
        }
        if (vendorModel && vendorModel.vendor_id !== upstream.vendor_id) {
            skipped.push(`vendor ${upstream.vendor_id}: vendor model ${vendorModel.id} belongs to another vendor`);
            continue;
        }

        // 请求路径只读：vendor_model 的补建已挪到 model 创建/更新时（ensureVendorModels）。
        // 这里查不到就当该候选不可用——正常流程下不应该发生，发生了就是配置漂移，需要去做一次配置保存。
        if (!vendorModel && !upstream.vendor_model_id && model.routing_mode !== ModelRoutingMode.LOAD_BALANCE) {
            skipped.push(
                `vendor ${upstream.vendor_id}: model ${model.name} is not configured on this vendor (re-save the model to auto-provision)`,
            );
            continue;
        }

        let supportedFormats: ApiFormat[];
        let upstreamFormat: ApiFormat;
        try {
            supportedFormats = vendorModel?.getSupportedFormats() ?? vendor.getSupportedFormats();
            upstreamFormat = protocolUtils.resolveUpstreamFormat(clientFormat, supportedFormats);
            // 解析不出该格式的 URL（缺 URL 或无法派生）时，该候选不可用
            if (vendor.getUrlByFormat(upstreamFormat) === null) {
                skipped.push(`vendor ${upstream.vendor_id}: no ${upstreamFormat} url`);
                continue;
            }
        } catch {
            skipped.push(`vendor ${upstream.vendor_id}: unsupported client format ${clientFormat}`);
            continue;
        }

        // 自动上游（无 vendor_model_id）同样参与冷却：key 使用模型名
        const vendorModelName = vendorModel?.model_id ?? model.name ?? "";

        // 健康状态与"本请求已试过"的过滤已下沉到各策略类
        candidates.push(
            new ModelRoutingResult(vendor, vendorModelName, upstreamFormat),
        );
    }

    if (candidates.length === 0) {
        // 带上逐个候选的不可用原因，避免只有一句 "No available upstream" 无从下手
        throw new customError.AppError(
            `No available upstream for model ${model.name}: ${skipped.join("; ") || "none"}`,
            503,
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
    ensureVendorModels,
    validateConfig,
    selectUpstream,
};
