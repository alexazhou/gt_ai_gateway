import { SgModel } from "../model/sgModel";
import modelManager from "../manager/modelManager";
import customError from "../util/customErrorUtil";
import routingService from "./routingService/core";


async function createModel(model: SgModel): Promise<SgModel> {
    if (model.enable && await modelManager.checkDuplicateEnabledModel(model.name ?? "")) {
        throw new customError.AppError("An enabled model with this name already exists", 409);
    }

    model.validatePrices();
    await routingService.validateConfig(model);
    await modelManager.save(model);
    return model;
}


async function updateModel(inputModel: SgModel): Promise<SgModel | null> {
    const model = await modelManager.findById(inputModel.id);

    if (!model) {
        return null;
    }

    const { id: _id, ...updateData } = inputModel.toData();
    model.fill(updateData);

    // Check for duplicate enabled model when enabling or changing name
    if (model.enable) {
        const isDuplicate = await modelManager.checkDuplicateEnabledModel(model.name ?? "", model.id);
        if (isDuplicate) {
            throw new customError.AppError("An enabled model with this name already exists", 409);
        }
    }

    model.validatePrices();
    await routingService.validateConfig(model);
    await modelManager.save(model);

    return await modelManager.findById(model.id);
}


export default {
    createModel,
    updateModel,
};
