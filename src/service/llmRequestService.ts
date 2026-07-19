import { ApiFormat } from "../constants";
import { SgModel } from "../model/sgModel";
import customError from "../util/customError";
import modelService from "./modelService";
import recordService from "./recordService";


interface LlmRequestContext {
    modelConfig: SgModel;
}


async function resolveContext(
    userId: number,
    modelName: string,
    body: string,
    format: ApiFormat,
): Promise<LlmRequestContext> {
    const modelConfig = await modelService.getModel(modelName, true);
    if (modelConfig == null) {
        await recordService.recordFailedRequest(userId, modelName, body, format, "model_not_found");
        throw new customError.NotFoundError("model not found");
    }

    return { modelConfig };
}

export default { resolveContext };
