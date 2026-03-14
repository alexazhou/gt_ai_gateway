import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";
import { SgModel } from "../model/sgModel";
import vendorService from "../service/vendorService";
import customError from "../util/customError";
import { ApiFormat } from "../constants";


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
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);

    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    return c.json(formatVendor(vendor));
}

async function getVendorsByIds(c: Context) {
    const body = await c.req.json();
    const ids = body.ids;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return c.json([]);
    }

    const idList = ids.map(id => parseInt(String(id), 10)).filter(id => !isNaN(id));
    if (idList.length === 0) {
        return c.json([]);
    }

    const vendors = await SgVendor.query().whereIn("id", idList).get();
    const formattedVendors = vendors.map(formatVendor);
    return c.json(formattedVendors);
}


async function createVendor(c: Context) {
    const body = await c.req.json();
    const { type, name, token, urls } = body;

    // Validation - 不验证 urls，允许为空
    if (!type || !name || !token) {
        throw new customError.AppError("Missing required fields");
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
        throw new customError.AppError("Invalid ID format");
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
        throw new customError.NotFoundError("Vendor not found");
    }

    return c.json(formatVendor(updatedVendor));
}


async function deleteVendor(c: Context) {
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);

    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    // 检查是否有关联的模型
    const models = await SgModel.query().where("vendor_id", vendorId).get();
    if (models.length > 0) {
        throw new customError.AppError("Cannot delete vendor with associated models");
    }

    await SgVendor.query().delete(vendorId);

    return c.json({ success: true });
}

async function testVendor(c: Context) {
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);
    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    const { format = ApiFormat.OPENAI } = await c.req.json().catch(() => ({}));
    
    let url = vendor.getUrlByFormat(format);
    const headers = new Headers();
    let body = "";

    if (format === ApiFormat.ANTHROPIC) {
        if (!url.endsWith("/v1/messages")) {
            url = url.replace(/\/$/, "") + "/v1/messages";
        }
        headers.set("x-api-key", vendor.token);
        headers.set("anthropic-version", "2023-06-01");
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
            model: "any-model", // Upstream might validate this, but for "ping" it might just return 401/404
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
        });
    } else {
        // OpenAI format
        headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        headers.set("Content-Type", "application/json");
        body = JSON.stringify({
            model: "any-model",
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
        });
    }

    try {
        console.log(`[testVendor] Testing vendor ${vendor.name} (${vendor.id}) at ${url}`);
        const startTime = Date.now();
        const response = await fetch(url, {
            method: "POST",
            headers,
            body,
        });
        const duration = Date.now() - startTime;
        const responseText = await response.text();
        let responseData;
        try {
            responseData = JSON.parse(responseText);
        } catch {
            responseData = responseText;
        }

        return c.json({
            success: response.ok,
            status: response.status,
            duration,
            response: responseData,
        });
    } catch (error: any) {
        return c.json({
            success: false,
            error: error.message || String(error),
        }, 500);
    }
}

export default {
    listVendors,
    getVendor,
    getVendorsByIds,
    createVendor,
    updateVendor,
    deleteVendor,
    testVendor,
};
