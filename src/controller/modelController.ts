import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { SgVendor } from "../model/sgVendor";

async function createModel(c: Context) {
    try {
        const body = await c.req.json();
        const { name, vendor_id } = body;

        console.log("[modelController] Creating model:", { name, vendor_id });

        // Validate required fields
        if (!name || !vendor_id) {
            return c.json({ error: "Missing required fields" }, 400);
        }

        // Validate vendor_id exists
        const vendor = await SgVendor.query().find(vendor_id);
        if (!vendor) {
            return c.json({ error: "Vendor not found" }, 404);
        }

        const instance = await SgModel.query().create({
            name,
            vendor_id,
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
    const { id } = c.req.param();

    const model = await SgModel.query().find(id);

    if (!model) {
        return c.json({ error: "Model not found" }, 404);
    }

    return c.json(model);
}

export default {
    createModel,
    listModels,
    getModel,
};
