import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";

async function listVendors(c: Context) {
    const users = await SgVendor.query().get();
    return c.json(users);
}

async function getVendor(c: Context) {
    const { id } = c.req.param();

    const vendor = await SgVendor.query().find(id);

    if (!vendor) {
        return c.json({ error: "Vendor not found" }, 404);
    }

    return c.json(vendor);
}

async function createVendor(c: Context) {
    const body = await c.req.json();
    const { type, name, token, url, api_format } = body;

    // Validation
    if (!type || !name || !token || !url) {
        return c.json({ error: "Missing required fields" }, 400);
    }

    // Validate api_format
    const validFormats = ["openai", "anthropic"];
    if (!api_format || !validFormats.includes(api_format)) {
        return c.json({ error: "Invalid api_format" }, 400);
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

export default {
    listVendors,
    getVendor,
    createVendor,
};
