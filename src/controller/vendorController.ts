import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";
import { SgModel } from "../model/sgModel";
import vendorService from "../service/vendorService";
import errorHandler from "../util/errorHandler";


/**
 * Format vendor for API response (parse URLs using model method)
 */
function formatVendor(vendor: SgVendor) {
    return {
        id: vendor.id,
        type: vendor.type,
        name: vendor.name,
        token: vendor.token,
        urls: vendor.getUrls(),
        created_at: vendor.created_at,
        updated_at: vendor.updated_at,
    };
}


async function listVendors(c: Context) {
    const vendors = await SgVendor.query().get();
    const formattedVendors = vendors.map(formatVendor);
    return c.json(formattedVendors);
}


async function getVendor(c: Context) {
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new errorHandler.AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);

    if (!vendor) {
        throw new errorHandler.NotFoundError("Vendor not found");
    }

    return c.json(formatVendor(vendor));
}


async function createVendor(c: Context) {
    const body = await c.req.json();
    const { type, name, token, urls } = body;

    // Validation - 不验证 urls，允许为空
    if (!type || !name || !token) {
        throw new errorHandler.AppError("Missing required fields");
    }

    const instance = await SgVendor.query().create({
        type,
        name,
        token,
        urls: urls ? JSON.stringify(urls) : "{}",
    });

    return c.json(formatVendor(instance));
}


async function updateVendor(c: Context) {
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new errorHandler.AppError("Invalid ID format");
    }

    const body = await c.req.json();
    const { type, name, token, urls } = body;

    const updatedVendor = await vendorService.updateVendor(vendorId, {
        type,
        name,
        token,
        urls,
    });

    if (!updatedVendor) {
        throw new errorHandler.NotFoundError("Vendor not found");
    }

    return c.json(formatVendor(updatedVendor));
}

export default {
    listVendors,
    getVendor,
    createVendor,
    updateVendor,
};
