import { ModelRoutingConfig, SgModel } from "../model/sgModel";

import { SgVendor } from "../model/sgVendor";
import { ModelRoutingMode } from "../constants";
import customError from "../util/customError";
import modelRoutingService from "./modelRoutingService";

interface ModelRoutingInput {
    vendor_id?: number;
    vendor_model_id?: number | null;
    routing_mode?: ModelRoutingMode;
    routing_config?: unknown;
}

interface ModelUpdateInput {
    name?: string;
    vendor_id?: number;
    vendor_model_id?: number | null;
    enable?: boolean;
    prices?: unknown;
    routing_mode?: ModelRoutingMode;
    routing_config?: unknown;
}


async function getModel(modelName: string, enable?: boolean): Promise<SgModel | null> {
    if (modelName == null) return null;

    const query = SgModel.query().where("name", modelName);

    // 如果 enable 参数非空，则按 enable 过滤
    if (enable !== undefined) {
        query.where("enable", enable);
    }

    return await query.first();
}


async function listEnabledModels() {
    const models = await SgModel.query()
        .where("enable", 1)
        .orderBy("id", "asc")
        .get();
    const modelList = models.toArray<SgModel>();
    const vendorIds = [...new Set(modelList.map(model => model.vendor_id as number))];
    const vendorList = vendorIds.length > 0
        ? (await SgVendor.query().whereIn("id", vendorIds).get()).toArray<SgVendor>()
        : [];
    const vendorMap = new Map(vendorList.map(vendor => [vendor.id, vendor]));

    return modelList.map(model => {
        const vendor = vendorMap.get(model.vendor_id!);
        if (!vendor) {
            throw new customError.AppError(`Vendor not found for model ${model.name}`, 500);
        }

        return {
            id: model.name,
            object: "model",
            created: Math.floor(new Date(model.created_at).getTime() / 1000),
            owned_by: vendor.name,
        };
    });
}


async function checkDuplicateEnabledModel(
    name: string,
    excludeId?: number,
): Promise<boolean> {
    const query = SgModel.query()
        .where("name", name)
        .where("enable", 1);
    if (excludeId) {
        query.where("id", "!=", excludeId);
    }
    const existing = await query.first();
    return !!existing;
}


async function resolveRoutingWriteData(
    modelName: string,
    data: ModelRoutingInput,
    currentModel?: SgModel,
): Promise<{
    routing_mode: ModelRoutingMode;
    routing_config: ModelRoutingConfig;
    vendor_id: number;
    vendor_model_id: number | null;
}> {
    const hasRoutingInput = data.routing_mode !== undefined || data.routing_config !== undefined;
    const hasLegacyRoutingInput = data.vendor_id !== undefined || data.vendor_model_id !== undefined;

    let mode = data.routing_mode ?? currentModel?.routing_mode ?? ModelRoutingMode.SINGLE;
    let config = data.routing_config ?? currentModel?.getRoutingConfig();
    if (!hasRoutingInput && (hasLegacyRoutingInput || !currentModel)) {
        const vendorId = data.vendor_id ?? currentModel?.vendor_id;
        if (!vendorId) {
            throw new customError.AppError("Missing required fields");
        }
        mode = ModelRoutingMode.SINGLE;
        const vendorModelId = data.vendor_model_id !== undefined
            ? data.vendor_model_id
            : currentModel?.vendor_model_id;
        config = new ModelRoutingConfig({
            upstreams: [{
                vendor_id: vendorId,
                ...(vendorModelId ? { vendor_model_id: vendorModelId } : {}),
                enabled: true,
            }],
        });
    }
    if (!config) {
        throw new customError.AppError("Missing required fields");
    }

    const validated = await modelRoutingService.validateConfig(modelName, mode, config);
    const firstEnabled = validated.config.upstreams.find(upstream => upstream.enabled)!;
    return {
        routing_mode: validated.mode,
        routing_config: validated.config,
        vendor_id: firstEnabled.vendor_id,
        vendor_model_id: firstEnabled.vendor_model_id ?? null,
    };
}


async function updateModel(
    modelId: number,
    data: ModelUpdateInput,
): Promise<SgModel | null> {
    const model = await SgModel.query().find(modelId);

    if (!model) {
        return null;
    }

    // Validate vendor_id exists if provided
    if (data.vendor_id !== undefined) {
        const vendor = await SgVendor.query().find(data.vendor_id);
        if (!vendor) {
            return null;
        }
    }

    // Check for duplicate enabled model when enabling or changing name
    const newName = data.name ?? model.name ?? "";
    const newEnable = data.enable !== undefined ? data.enable : model.enable;

    if (newEnable) {
        const isDuplicate = await checkDuplicateEnabledModel(newName, modelId);
        if (isDuplicate) {
            throw new customError.AppError("An enabled model with this name already exists", 409);
        }
    }

    // Note: name, vendor_id, enable, input_price, output_price can be updated. The id cannot be modified.
    const updateData: Record<string, unknown> = {
        name: newName,
        vendor_id: data.vendor_id ?? model.vendor_id,
        enable: newEnable,
    };

    if (data.prices !== undefined) {
        updateData.prices = JSON.stringify(data.prices);
    }

    if ("vendor_model_id" in data) {
        updateData.vendor_model_id = data.vendor_model_id ?? null;
    }

    const hasRoutingUpdate = data.vendor_id !== undefined
        || data.vendor_model_id !== undefined
        || data.routing_mode !== undefined
        || data.routing_config !== undefined;
    if (hasRoutingUpdate) {
        const routing = await resolveRoutingWriteData(newName, data, model);
        updateData.vendor_id = routing.vendor_id;
        updateData.vendor_model_id = routing.vendor_model_id;
        updateData.routing_mode = routing.routing_mode;
        updateData.routing_config = JSON.stringify(routing.routing_config);
    }

    await SgModel.query()
        .where("id", modelId)
        .update(updateData);

    return await SgModel.query().find(modelId);
}


async function deleteModel(modelId: number): Promise<boolean> {
    const model = await SgModel.query().find(modelId);

    if (!model) {
        return false;
    }

    await SgModel.query().where("id", modelId).delete();
    return true;
}

export default {
    getModel,
    listEnabledModels,
    resolveRoutingWriteData,
    updateModel,
    deleteModel,
};
