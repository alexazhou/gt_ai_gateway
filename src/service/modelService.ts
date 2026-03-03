import { SgModel } from "../model/sgModel";

import { SgVendor } from "../model/sgVendor";
import { AppError } from "../util/errorHandler";


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
    data: { name?: string; vendor_id?: number; enable?: boolean },
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
            throw new AppError("An enabled model with this name already exists", 409);
        }
    }

    // Note: Only name, vendor_id, and enable can be updated. The id cannot be modified.
    await SgModel.query()
        .where("id", modelId)
        .update({
            name: newName,
            vendor_id: data.vendor_id ?? model.vendor_id,
            enable: newEnable,
        });

    return await SgModel.query().find(modelId);
}

export default {
    getModel,
    updateModel,
};
