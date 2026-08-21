import { SgModel } from "../model/sgModel";
import modelManager from "../manager/modelManager";
import customError from "../util/customErrorUtil";
import routingService from "./routingService/core";


async function createModel(model: SgModel): Promise<SgModel> {
    if (await modelManager.checkDuplicateModel(model.name ?? "")) {
        throw new customError.AppError("A model with this name already exists", 409);
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

    // Check for duplicate model name (regardless of enable)
    const isDuplicate = await modelManager.checkDuplicateModel(model.name ?? "", model.id);
    if (isDuplicate) {
        throw new customError.AppError("A model with this name already exists", 409);
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
