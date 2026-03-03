import { SgModel } from "../model/sgModel";

async function getModel(modelName: string): Promise<SgModel | null> {
    if (modelName == null) return null;

    return await SgModel.query().where("name", modelName).first();
}

export default {
    getModel,
};
