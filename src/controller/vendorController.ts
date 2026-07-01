import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";
import { SgModel } from "../model/sgModel";
import vendorService from "../service/vendorService";
import vendorDefaultUrls from "../service/vendorDefaultUrls";
import ormService from "../service/ormService";
import senderService from "../service/senderService";
import customError from "../util/customError";
import { ApiFormat, VendorAuthMode } from "../constants";
import { createListResponse, parsePaginationQuery } from "../util/pagination";


/**
 * Format vendor for API response (parse URLs using model method)
 */
function formatVendor(vendor: SgVendor, modelCount = 0) {
    return {
        id: vendor.id,
        type: vendor.type,
        name: vendor.name,
        token: vendor.token,
        urls: vendor.getUrls(),
        auth_mode: vendor.getAuthMode(),
        model_count: modelCount,
        created_at: vendor.created_at,
        updated_at: vendor.updated_at,
    };
}


async function listVendors(c: Context) {
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const dbQuery = SgVendor.query().orderBy("id", "desc");

    if (query.type) {
        dbQuery.where("type", query.type);
    }

    if (query.keyword) {
        dbQuery.where("name", "like", `%${query.keyword}%`);
    }

    const total = Number(await dbQuery.clone().count() || 0);
    const vendors = await dbQuery.limit(pageSize).offset(offset).get();

    // Single GROUP BY COUNT query for this page's vendor IDs
    const vendorIds: number[] = (vendors as any).all().map((v: SgVendor) => v.id);
    const countMap = new Map<number, number>();
    if (vendorIds.length > 0) {
        const knex = ormService.getKnex();
        const rows: { vendor_id: number; cnt: number }[] = await knex("vendor_model")
            .select(["vendor_id", knex.raw("count(*) as cnt")])
            .whereIn("vendor_id", vendorIds)
            .groupBy("vendor_id");
        rows.forEach(row => {
            countMap.set(Number(row.vendor_id), Number(row.cnt));
        });
    }

    const formattedVendors = vendors.map(v => formatVendor(v, countMap.get(v.id) ?? 0));
    return c.json(createListResponse(formattedVendors.toArray(), total));
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
    const { type, name, token, urls, auth_mode } = body;

    // Validation - 不验证 urls，允许为空
    if (!type || !name || !token) {
        throw new customError.AppError("Missing required fields");
    }

    const finalAuthMode = auth_mode === VendorAuthMode.BEARER_TOKEN
        ? VendorAuthMode.BEARER_TOKEN
        : VendorAuthMode.API_KEY;

    const instance = await SgVendor.query().create({
        type,
        name,
        token,
        urls: urls ? JSON.stringify(urls) : "{}",
        auth_mode: finalAuthMode,
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
    const { type, name, token, urls, auth_mode } = body;

    const updatedVendor = await vendorService.updateVendor(vendorId, {
        type,
        name,
        token,
        urls,
        auth_mode,
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
    const relatedModelCount = Number(await SgModel.query().where("vendor_id", vendorId).count() || 0);
    if (relatedModelCount > 0) {
        throw new customError.AppError("Cannot delete vendor with associated models");
    }

    await SgVendor.query().where("id", vendorId).delete();

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

    const bodyJson = await c.req.json().catch(() => ({}));
    const { format = ApiFormat.OPENAI, model = "test-ping", auto_convert = false } = bodyJson;

    let requestFormat: ApiFormat = format;
    let convertedFrom: string | undefined;
    let convertedTo: string | undefined;

    if (auto_convert) {
        const upstreamFormat = senderService.resolveUpstreamFormat(format, vendor.getSupportedFormats());
        if (upstreamFormat !== format) {
            convertedFrom = format;
            convertedTo = upstreamFormat;
            requestFormat = upstreamFormat;
        }
    }

    const url = vendor.getUrlByFormat(requestFormat);
    const headers = new Headers();
    let upstreamBody = "";

    if (requestFormat === ApiFormat.ANTHROPIC) {
        if (vendor.isBearerTokenAuth()) {
            headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        } else {
            headers.set("x-api-key", vendor.token);
            headers.set("anthropic-version", "2023-06-01");
        }
        headers.set("Content-Type", "application/json");
        upstreamBody = JSON.stringify({
            model: model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
        });
    } else if (requestFormat === ApiFormat.RESPONSES) {
        headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        headers.set("Content-Type", "application/json");
        upstreamBody = JSON.stringify({
            model: model,
            input: "ping",
            max_output_tokens: 16,
        });
    } else {
        headers.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        headers.set("Content-Type", "application/json");
        upstreamBody = JSON.stringify({
            model: model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 5,
        });
    }

    try {
        console.log(`[testVendor] Testing vendor ${vendor.name} (${vendor.id}) with model ${model} at ${url}`);
        const startTime = Date.now();
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: upstreamBody,
        });
        const duration = Date.now() - startTime;
        const responseText = await response.text();
        let responseData;
        try {
            responseData = JSON.parse(responseText);
        } catch {
            responseData = responseText;
        }

        const headerEntries = Array.from(headers.entries()).map(([key, value]) => {
            if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key') {
                const visible = value.length > 12 ? value.slice(0, 8) + '****' + value.slice(-4) : '****';
                return [key, visible];
            }
            return [key, value];
        });

        let requestBodyDisplay: unknown = upstreamBody;
        try {
            requestBodyDisplay = JSON.parse(upstreamBody);
        } catch {}

        return c.json({
            success: response.ok,
            status: response.status,
            duration,
            url,
            converted_from: convertedFrom,
            converted_to: convertedTo,
            request_method: "POST",
            request_headers: Object.fromEntries(headerEntries),
            request_body: requestBodyDisplay,
            response: responseData,
        });
    } catch (error: any) {
        let requestBodyDisplay: unknown = upstreamBody;
        try {
            requestBodyDisplay = JSON.parse(upstreamBody);
        } catch {}

        const headerEntries = Array.from(headers.entries()).map(([key, value]) => {
            if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key') {
                const visible = value.length > 12 ? value.slice(0, 8) + '****' + value.slice(-4) : '****';
                return [key, visible];
            }
            return [key, value];
        });

        return c.json({
            success: false,
            error: error.message || String(error),
            url,
            request_method: "POST",
            request_headers: Object.fromEntries(headerEntries),
            request_body: requestBodyDisplay,
        }, 500);
    }
}

async function getPresetUrls(c: Context) {
    return c.json(vendorDefaultUrls.getAllUrls());
}


export default {
    listVendors,
    getVendor,
    getVendorsByIds,
    createVendor,
    updateVendor,
    deleteVendor,
    testVendor,
    getPresetUrls,
};
