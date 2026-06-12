import { SgModel } from "../model/sgModel";

import { SgVendor } from "../model/sgVendor";
import customError from "../util/customError";


async function getModel(modelName: string, enable?: boolean): Promise<SgModel | null> {
    if (modelName == null) return null;

    const query = SgModel.query().where("name", modelName);

    // 如果 enable 参数非空，则按 enable 过滤
    if (enable !== undefined) {
        query.where("enable", enable);
    }

    return await query.first();
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


async function updateModel(
    modelId: number,
    data: { name?: string; vendor_id?: number; enable?: boolean; prices?: any; vendor_model_id?: number | null },
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
    const newName = data.name ?? model.name;
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

    await SgModel.query()
        .where("id", modelId)
        .update(updateData);

    return await SgModel.query().find(modelId);
}

export default {
    getModel,
    updateModel,
};
