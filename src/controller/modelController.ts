import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";
import modelService from "../service/modelService";
import { AppError, NotFoundError } from "../util/errorHandler";


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
    const { name, vendor_id, enable = true } = body;

    console.log("[modelController] Creating model:", { name, vendor_id, enable });

    // Validate required fields
    if (!name || !vendor_id) {
        throw new AppError("Missing required fields");
    }

    // Validate vendor_id exists
    const vendor = await SgVendor.query().find(vendor_id);
    if (!vendor) {
        throw new NotFoundError("Vendor not found");
    }

    // Check for duplicate enabled model
    if (enable) {
        const isDuplicate = await checkDuplicateEnabledModel(name);
        if (isDuplicate) {
            throw new AppError("An enabled model with this name already exists", 409);
        }
    }

    const instance = await SgModel.query().create({
        name,
        vendor_id,
        enable,
    });

    console.log("[modelController] Model created successfully:", instance);
    return c.json(instance);
}


async function listModels(c: Context) {
    const modelConfigs = await SgModel.query().get();
    return c.json(modelConfigs);
}


async function getModel(c: Context) {
    const id = c.req.param("id");
    const modelId = parseInt(id, 10);

    if (isNaN(modelId)) {
        throw new AppError("Invalid ID format");
    }

    const model = await SgModel.query().find(modelId);

    if (!model) {
        throw new NotFoundError("Model not found");
    }

    return c.json(model);
}


async function updateModel(c: Context) {
    const id = c.req.param("id");
    const modelId = parseInt(id, 10);

    if (isNaN(modelId)) {
        throw new AppError("Invalid ID format");
    }

    const { name, vendor_id, enable } = await c.req.json();

    console.log("[modelController] Updating model:", {
        modelId,
        name,
        vendor_id,
        enable,
    });

    const updatedModel = await modelService.updateModel(modelId, {
        name,
        vendor_id,
        enable,
    });

    if (!updatedModel) {
        throw new NotFoundError("Model not found");
    }

    console.log("[modelController] Model updated successfully:", updatedModel);
    return c.json(updatedModel);
}

export default {
    createModel,
    listModels,
    getModel,
    updateModel,
};
