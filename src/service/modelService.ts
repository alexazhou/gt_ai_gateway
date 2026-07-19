import type { Builder } from "sutando";
import { SgModel } from "../model/sgModel";

import { SgVendor } from "../model/sgVendor";
import customError from "../util/customError";
import modelRoutingService from "./modelRoutingService";

interface ModelListOptions {
    vendorId?: number;
    keyword?: string;
    pageSize: number;
    offset: number;
}


function filterByVendor(query: Builder<SgModel>, vendorId: number): void {
    query.whereRaw(
        "EXISTS (SELECT 1 FROM json_each(model.routing_config, '$.upstreams') AS upstream WHERE json_extract(upstream.value, '$.vendor_id') = ?)",
        [vendorId],
    );
}


async function getModel(modelName: string, enable?: boolean): Promise<SgModel | null> {
    if (modelName == null) return null;

    const query = SgModel.query().where("name", modelName);

    // 如果 enable 参数非空，则按 enable 过滤
    if (enable !== undefined) {
        query.where("enable", enable);
    }

    return await query.first();
}


async function listModels(options: ModelListOptions) {
    const query = SgModel.query().orderBy("id", "desc");
    if (options.vendorId) {
        filterByVendor(query, options.vendorId);
    }
    if (options.keyword) {
        query.where("name", "like", `%${options.keyword}%`);
    }

    const total = Number(await query.clone().count() || 0);
    const models = await query.limit(options.pageSize).offset(options.offset).get();
    return {
        list: models.toArray<SgModel>(),
        total,
    };
}


async function hasModelsUsingVendor(vendorId: number): Promise<boolean> {
    const query = SgModel.query();
    filterByVendor(query, vendorId);
    return Number(await query.count() || 0) > 0;
}


async function listEnabledModels() {
    const models = await SgModel.query()
        .where("enable", 1)
        .orderBy("id", "asc")
        .get();
    const modelList = models.toArray<SgModel>();
    const vendorIds = [...new Set(modelList.flatMap(model => (
        model.getRoutingConfig().upstreams
            .filter(upstream => upstream.enabled)
            .map(upstream => upstream.vendor_id)
    )))];
    const vendorList = vendorIds.length > 0
        ? (await SgVendor.query().whereIn("id", vendorIds).get()).toArray<SgVendor>()
        : [];
    const vendorMap = new Map(vendorList.map(vendor => [vendor.id, vendor]));

    return modelList.map(model => {
        const vendorNames = [...new Set(model.getRoutingConfig().upstreams
            .filter(upstream => upstream.enabled)
            .map(upstream => vendorMap.get(upstream.vendor_id)?.name)
            .filter((name): name is string => Boolean(name)))];
        if (vendorNames.length === 0) {
            throw new customError.AppError(`Vendor not found for model ${model.name}`, 500);
        }

        return {
            id: model.name,
            object: "model",
            created: Math.floor(new Date(model.created_at).getTime() / 1000),
            owned_by: vendorNames.join(", "),
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


async function createModel(model: SgModel): Promise<SgModel> {
    if (model.enable && await checkDuplicateEnabledModel(model.name ?? "")) {
        throw new customError.AppError("An enabled model with this name already exists", 409);
    }

    await modelRoutingService.validateConfig(model);
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
    listModels,
    hasModelsUsingVendor,
    listEnabledModels,
    createModel,
    updateModel,
    deleteModel,
};
