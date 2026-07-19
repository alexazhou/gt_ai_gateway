import { ApiFormat, ModelRoutingMode } from "../constants";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";
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

    if (modelConfig.routing_mode !== ModelRoutingMode.SINGLE) {
        return { modelConfig };
    }

    const vendor = await SgVendor.query().find(modelConfig.vendor_id!);
    if (vendor == null) {
        await recordService.recordFailedRequest(
            userId,
            modelName,
            body,
            format,
            "vendor_not_found",
            modelConfig.id,
            modelConfig.vendor_id,
        );
        throw new customError.NotFoundError("vendor not found");
    }

    return { modelConfig };
}

export default { resolveContext };
