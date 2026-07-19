import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";
import modelService from "../service/modelService";
import customError from "../util/customError";
import { createListResponse, parsePaginationQuery } from "../util/pagination";


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


async function createModel(c: Context) {
    const body = await c.req.json();
    const { name, vendor_id, enable = true, prices = {}, vendor_model_id = null, routing_mode, routing_config } = body;

    console.log("[modelController] Creating model:", { name, vendor_id, enable, prices, vendor_model_id });

    // Validate required fields
    if (!name || (!vendor_id && !routing_config)) {
        throw new customError.AppError("Missing required fields");
    }

    // Validate vendor_id exists
    if (vendor_id) {
        const vendor = await SgVendor.query().find(vendor_id);
        if (!vendor) {
            throw new customError.NotFoundError("Vendor not found");
        }
    }

    // Check for duplicate enabled model
    if (enable) {
        const isDuplicate = await checkDuplicateEnabledModel(name);
        if (isDuplicate) {
            throw new customError.AppError("An enabled model with this name already exists", 409);
        }
    }

    const routing = await modelService.resolveRoutingWriteData(name, {
        vendor_id,
        vendor_model_id,
        routing_mode,
        routing_config,
    });
    const instance = await SgModel.query().create({
        name,
        vendor_id: routing.vendor_id,
        enable,
        prices,
        vendor_model_id: routing.vendor_model_id,
        routing_mode: routing.routing_mode,
        routing_config: routing.routing_config,
    });

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

    const { name, vendor_id, enable, prices, vendor_model_id, routing_mode, routing_config } = await c.req.json();

    console.log("[modelController] Updating model:", {
        modelId,
        name,
        vendor_id,
        enable,
        prices,
        vendor_model_id,
        routing_mode,
        routing_config,
    });

    const updatedModel = await modelService.updateModel(modelId, {
        name,
        vendor_id,
        enable,
        prices,
        vendor_model_id,
        routing_mode,
        routing_config,
    });

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
