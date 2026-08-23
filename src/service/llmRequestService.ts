import { ApiFormat } from "../constants";
import { SgModel } from "../model/sgModel";
import customError from "../customError";
import modelManager from "../manager/modelManager";
import recordService from "./recordService";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";


interface LlmRequestContext {
    modelConfig: SgModel;
}


async function resolveContext(
    userId: number,
    modelName: string,
    body: string,
    format: ApiFormat,
    scope: TenantScope,
): Promise<LlmRequestContext> {
    const modelConfig = await modelManager.getModel(modelName, true, scope);
    if (modelConfig == null) {
        await recordService.recordFailedRequest(
            userId,
            modelName,
            body,
            format,
            "model_not_found",
            null,
            undefined,
            undefined,
            scope.tenantId,
        );
        throw new customError.NotFoundError("model not found");
    }

    return { modelConfig };
}

export default { resolveContext };
