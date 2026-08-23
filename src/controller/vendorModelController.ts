import { Context } from "hono";
import { SgVendorModel } from "../model/sgVendorModel";
import { SgVendor } from "../model/sgVendor";
import vendorManager from "../manager/vendorManager";
import vendorModelManager from "../manager/vendorModelManager";
import vendorService from "../service/vendorService";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";
import customError from "../customError";
import { ApiFormat } from "../constants";


function serializeVendorModel(m: SgVendorModel) {
    return {
        ...m.toData(),
        allowed_formats: m.getAllowedFormats(),
    };
}


// vendor_model 经 vendor 间接隔离：vendor 必须在当前视角租户内
async function getScopedVendor(c: Context, vendorId: number): Promise<SgVendor> {
    const scope = c.get("tenantScope")!;
    const vendor = await vendorManager.findByIdInTenant(vendorId, scope.tenantId);
    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }
    return vendor;
}


async function listVendorModels(c: Context) {
    const scope = c.get("tenantScope")!;
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }
    await getScopedVendor(c, vendorId);

    const models = await vendorModelManager.listByVendor(vendorId);

    return c.json(models.map(serializeVendorModel));
}


async function fetchVendorModels(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await getScopedVendor(c, vendorId);

    const models = await vendorService.fetchUpstreamModels(vendor);
    return c.json({ models });
}


async function syncVendorModels(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    await getScopedVendor(c, vendorId);

    const body = await c.req.json();
    const { model_ids } = body;

    if (!Array.isArray(model_ids)) {
        throw new customError.AppError("model_ids must be an array");
    }

    const updated = await vendorModelManager.syncByVendor(vendorId, model_ids);

    return c.json(updated.map(serializeVendorModel));
}


async function addVendorModel(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    await getScopedVendor(c, vendorId);

    const body = await c.req.json();
    const { model_id } = body;

    if (!model_id || typeof model_id !== "string" || !model_id.trim()) {
        throw new customError.AppError("model_id is required");
    }

    const trimmed = model_id.trim();

    const record = await vendorModelManager.add(vendorId, trimmed);

    return c.json(serializeVendorModel(record));
}


async function getVendorModelsByIds(c: Context) {
    const scope = c.get("tenantScope")!;
    const body = await c.req.json();
    const ids = body.ids;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return c.json([]);
    }

    const idList = ids.map((id: unknown) => parseInt(String(id), 10)).filter((id: number) => !isNaN(id));
    if (idList.length === 0) {
        return c.json([]);
    }

    const models = await vendorModelManager.getByIds(idList, scope.tenantId);
    return c.json(models.map(serializeVendorModel));
}


async function updateVendorModel(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    const recordId = parseInt(c.req.param("modelId"), 10);

    if (isNaN(vendorId) || isNaN(recordId)) {
        throw new customError.AppError("Invalid ID format");
    }

    await getScopedVendor(c, vendorId);

    const body = await c.req.json();
    const { allowed_formats } = body;

    let allowedFormatsJson: string | null = null;
    if (Array.isArray(allowed_formats) && allowed_formats.length > 0) {
        const validFormats = Object.values(ApiFormat);
        const filtered = allowed_formats.filter((f: unknown) => validFormats.includes(f as ApiFormat));
        allowedFormatsJson = filtered.length > 0 ? JSON.stringify(filtered) : null;
    }

    const updated = await vendorModelManager.update(recordId, vendorId, allowedFormatsJson);
    if (!updated) {
        throw new customError.NotFoundError("Vendor model not found");
    }

    return c.json(serializeVendorModel(updated));
}


async function deleteVendorModel(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    const recordId = parseInt(c.req.param("modelId"), 10);

    if (isNaN(vendorId) || isNaN(recordId)) {
        throw new customError.AppError("Invalid ID format");
    }

    await getScopedVendor(c, vendorId);

    const removed = await vendorModelManager.remove(recordId, vendorId);
    if (!removed) {
        throw new customError.NotFoundError("Vendor model not found");
    }

    return c.json({ success: true });
}


export default {
    listVendorModels,
    fetchVendorModels,
    syncVendorModels,
    addVendorModel,
    updateVendorModel,
    deleteVendorModel,
    getVendorModelsByIds,
};
