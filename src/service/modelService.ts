import { SgModel } from "../model/sgModel";

import { SgVendor } from "../model/sgVendor";
import customError from "../util/customError";
import modelRoutingService from "./modelRoutingService";


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


function syncLegacyRoutingFields(model: SgModel): void {
    const firstEnabled = model.getRoutingConfig().upstreams.find(upstream => upstream.enabled);
    if (!firstEnabled) {
        return;
    }

    model.vendor_id = firstEnabled.vendor_id;
    model.vendor_model_id = firstEnabled.vendor_model_id ?? null;
}


async function createModel(model: SgModel): Promise<SgModel> {
    if (model.enable && await checkDuplicateEnabledModel(model.name ?? "")) {
        throw new customError.AppError("An enabled model with this name already exists", 409);
    }

    await modelRoutingService.validateConfig(model);
    syncLegacyRoutingFields(model);
    await model.save();
    return model;
}


async function updateModel(inputModel: SgModel): Promise<SgModel | null> {
    const model = await SgModel.query().find(inputModel.id);

    if (!model) {
        return null;
    }

    const { id: _id, ...updateData } = inputModel.toData();
    model.fill(updateData);

    // Check for duplicate enabled model when enabling or changing name
    if (model.enable) {
        const isDuplicate = await checkDuplicateEnabledModel(model.name ?? "", model.id);
        if (isDuplicate) {
            throw new customError.AppError("An enabled model with this name already exists", 409);
        }
    }

    await modelRoutingService.validateConfig(model);
    syncLegacyRoutingFields(model);
    await model.save();

    return await SgModel.query().find(model.id);
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
    createModel,
    updateModel,
    deleteModel,
};
