import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";
import vendorService from "../service/vendorService";
import { AppError, NotFoundError } from "../util/errorHandler";


async function listVendors(c: Context) {
    const users = await SgVendor.query().get();
    return c.json(users);
}


async function getVendor(c: Context) {
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);

    if (!vendor) {
        throw new NotFoundError("Vendor not found");
    }

    return c.json(vendor);
}


async function createVendor(c: Context) {
    const body = await c.req.json();
    const { type, name, token, url, api_format } = body;

    // Validation
    if (!type || !name || !token || !url) {
        throw new AppError("Missing required fields");
    }

    // Validate api_format
    const validFormats = ["openai", "anthropic"];
    if (!api_format || !validFormats.includes(api_format)) {
        throw new AppError("Invalid api_format");
    }

    const instance = await SgVendor.query().create({
        type,
        name,
        token,
        url,
        api_format,
    });

    return c.json(instance);
}


async function updateVendor(c: Context) {
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new AppError("Invalid ID format");
    }

    const body = await c.req.json();
    const { type, name, token, url, api_format } = body;

    const updatedVendor = await vendorService.updateVendor(vendorId, {
        type,
        name,
        token,
        url,
        api_format,
    });

    if (!updatedVendor) {
        throw new NotFoundError("Vendor not found");
    }

    return c.json(updatedVendor);
}

export default {
    listVendors,
    getVendor,
    createVendor,
    updateVendor,
};
