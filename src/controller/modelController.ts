import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";

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
    try {
        const body = await c.req.json();
        const { name, vendor_id, enable = true } = body;

        console.log("[modelController] Creating model:", { name, vendor_id, enable });

        // Validate required fields
        if (!name || !vendor_id) {
            return c.json({ error: "Missing required fields" }, 400);
        }

        // Validate vendor_id exists
        const vendor = await SgVendor.query().find(vendor_id);
        if (!vendor) {
            return c.json({ error: "Vendor not found" }, 404);
        }

        // Check for duplicate enabled model
        if (enable) {
            const isDuplicate = await checkDuplicateEnabledModel(name);
            if (isDuplicate) {
                return c.json(
                    { error: "An enabled model with this name already exists" },
                    400,
                );
            }
        }

        const instance = await SgModel.query().create({
            name,
            vendor_id,
            enable,
        });

        console.log("[modelController] Model created successfully:", instance);
        return c.json(instance);
    } catch (error) {
        console.error("[modelController] Error creating model:", error);
        return c.json(
            { error: "Failed to create model", message: String(error) },
            500,
        );
    }
}

async function listModels(c: Context) {
    const modelConfigs = await SgModel.query().get();
    return c.json(modelConfigs);
}

async function getModel(c: Context) {
    const id = c.req.param("id");
    const modelId = parseInt(id, 10);

    if (isNaN(modelId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const model = await SgModel.query().find(modelId);

    if (!model) {
        return c.json({ error: "Model not found" }, 404);
    }

    return c.json(model);
}


async function updateModel(c: Context) {
    try {
        const id = c.req.param("id");
        const modelId = parseInt(id, 10);

        if (isNaN(modelId)) {
            return c.json({ error: "Invalid ID format" }, 400);
        }

        const { name, vendor_id, enable } = await c.req.json();

        console.log("[modelController] Updating model:", {
            modelId,
            name,
            vendor_id,
            enable,
        });

        const model = await SgModel.query().find(modelId);

        if (!model) {
            return c.json({ error: "Model not found" }, 404);
        }

        // Validate vendor_id exists if provided
        if (vendor_id !== undefined) {
            const vendor = await SgVendor.query().find(vendor_id);
            if (!vendor) {
                return c.json({ error: "Vendor not found" }, 404);
            }
        }

        // Check for duplicate enabled model when enabling or changing name
        const newName = name ?? model.name;
        const newEnable = enable !== undefined ? enable : model.enable;

        if (newEnable) {
            const isDuplicate = await checkDuplicateEnabledModel(newName, modelId);
            if (isDuplicate) {
                return c.json(
                    { error: "An enabled model with this name already exists" },
                    400,
                );
            }
        }

        await SgModel.query()
            .where("id", modelId)
            .update({
                name: name ?? model.name,
                vendor_id: vendor_id ?? model.vendor_id,
                enable: enable !== undefined ? enable : model.enable,
            });

        const updatedModel = await SgModel.query().find(modelId);
        console.log("[modelController] Model updated successfully:", updatedModel);
        return c.json(updatedModel);
    } catch (error) {
        console.error("[modelController] Error updating model:", error);
        return c.json(
            { error: "Failed to update model", message: String(error) },
            500,
        );
    }
}

export default {
    createModel,
    listModels,
    getModel,
    updateModel,
};
