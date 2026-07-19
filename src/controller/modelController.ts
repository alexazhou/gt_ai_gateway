import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import modelService from "../service/modelService";
import customError from "../util/customError";
import { createListResponse, parsePaginationQuery } from "../util/pagination";


async function createModel(c: Context) {
    const model = new SgModel(await c.req.json());
    console.log("[modelController] Creating model:", model);

    const instance = await modelService.createModel(model);

    console.log("[modelController] Model created successfully:", instance);
    return c.json(instance);
}


async function listModels(c: Context) {
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const dbQuery = SgModel.query().orderBy("id", "desc");

    if (query.vendor_id) {
        const vendorId = parseInt(query.vendor_id, 10);
        if (!isNaN(vendorId)) {
            dbQuery.where("vendor_id", vendorId);
        }
    }

    if (query.keyword) {
        dbQuery.where("name", "like", `%${query.keyword}%`);
    }

    const total = Number(await dbQuery.clone().count() || 0);
    const modelConfigs = await dbQuery.limit(pageSize).offset(offset).get();
    return c.json(createListResponse(modelConfigs.toArray(), total));
}


async function listLlmModels(c: Context) {
    const models = await modelService.listEnabledModels();
    return c.json({
        object: "list",
        data: models,
    });
}


async function getModel(c: Context) {
    const id = c.req.param("id");
    const modelId = parseInt(id, 10);

    if (isNaN(modelId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const model = await SgModel.query().find(modelId);

    if (!model) {
        throw new customError.NotFoundError("Model not found");
    }

    return c.json(model);
}

async function getModelsByIds(c: Context) {
    const body = await c.req.json();
    const ids = body.ids;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return c.json([]);
    }

    const idList = ids.map(id => parseInt(String(id), 10)).filter(id => !isNaN(id));
    if (idList.length === 0) {
        return c.json([]);
    }

    const models = await SgModel.query().whereIn("id", idList).get();
    return c.json(models);
}


async function updateModel(c: Context) {
    const id = c.req.param("id");
    const modelId = parseInt(id, 10);

    if (isNaN(modelId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const model = new SgModel(await c.req.json());
    model.id = modelId;
    console.log("[modelController] Updating model:", model);

    const updatedModel = await modelService.updateModel(model);

    if (!updatedModel) {
        throw new customError.NotFoundError("Model not found");
    }

    console.log("[modelController] Model updated successfully:", updatedModel);
    return c.json(updatedModel);
}


async function deleteModel(c: Context) {
    const id = c.req.param("id");
    const modelId = Number(id);

    if (!Number.isInteger(modelId) || modelId <= 0) {
        throw new customError.AppError("Invalid ID format");
    }

    const deleted = await modelService.deleteModel(modelId);

    if (!deleted) {
        throw new customError.NotFoundError("Model not found");
    }

    return c.json({ success: true });
}

export default {
    createModel,
    listModels,
    listLlmModels,
    getModel,
    getModelsByIds,
    updateModel,
    deleteModel,
};
