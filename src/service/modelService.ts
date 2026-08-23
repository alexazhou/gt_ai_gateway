import { SgModel } from "../model/sgModel";
import modelManager from "../manager/modelManager";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";
import customError from "../customError";
import routingService from "./routingService/core";


/**
 * 模型共享校验：仅 main 租户下的模型可置 cross_tenant = 1（其它租户请求置 1 时拒绝）。
 * 归属校验：目标模型必须属于 scope.tenantId（root 也受视角约束）。
 */
function assertModelScope(model: SgModel, scope: TenantScope, forUpdate: boolean): void {
    if (forUpdate && model.tenant_id !== scope.tenantId) {
        // 共享模型只读：非 main 视角编辑 main 共享模型 → 403
        throw new customError.AppError("Shared model is read-only", 403);
    }
    if (model.cross_tenant && model.tenant_id !== scope.mainTenantId) {
        throw new customError.AppError("Only models in the main tenant can be marked as globally shared", 400);
    }
}


// 布尔归一化：接受 true/1（跨租户共享开关）
function toBoolean(value: unknown): boolean {
    return value === true || value === 1;
}


async function createModel(model: SgModel, scope: TenantScope): Promise<SgModel> {
    // 归属由服务端写入，客户端 body 中的 tenant_id 忽略；cross_tenant 归一化
    model.tenant_id = scope.tenantId;
    model.cross_tenant = toBoolean(model.cross_tenant);

    if (await modelManager.checkDuplicateModel(model.name ?? "", scope.tenantId)) {
        throw new customError.AppError("A model with this name already exists", 409);
    }

    assertModelScope(model, scope, false);

    model.validatePrices();
    await routingService.validateConfig(model, model.tenant_id ?? undefined);
    await modelManager.save(model);
    return model;
}


async function updateModel(inputModel: SgModel, scope: TenantScope): Promise<SgModel | null> {
    const model = await modelManager.findById(inputModel.id);

    if (!model) {
        return null;
    }

    // 共享模型只读校验：目标必须属于本视角租户
    assertModelScope(model, scope, true);

    const { id: _id, tenant_id: _tenantId, ...updateData } = inputModel.toData();
    model.fill(updateData);
    model.cross_tenant = toBoolean(model.cross_tenant);

    // 归属与共享标记随原模型，不由客户端覆盖；共享标记仅 main 租户可置 1
    assertModelScope(model, scope, false);

    // Check for duplicate model name（租户内唯一，无论 enable）
    const isDuplicate = await modelManager.checkDuplicateModel(model.name ?? "", scope.tenantId, model.id);
    if (isDuplicate) {
        throw new customError.AppError("A model with this name already exists", 409);
    }

    model.validatePrices();
    await routingService.validateConfig(model, model.tenant_id ?? undefined);
    await modelManager.save(model);

    return await modelManager.findById(model.id);
}


export default {
    createModel,
    updateModel,
};
