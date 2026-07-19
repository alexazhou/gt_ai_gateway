import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";
import vendorService from "../service/vendorService";
import vendorDefaultUrls from "../service/vendorDefaultUrls";
import vendorTestService from "../service/vendorTestService";
import modelService from "../service/modelService";
import ormService from "../service/ormService";
import senderService from "../service/senderService";
import customError from "../util/customError";
import { ApiFormat } from "../constants";
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
        urls: vendor.urls,
        config: vendor.config,
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
    const { type, name, token, urls, config } = body;

    // Validation - 不验证 urls，允许为空
    if (!type || !name || !token) {
        throw new customError.AppError("Missing required fields");
    }

    const finalConfig = config || {};
    vendorService.validateProxyConfig(finalConfig);

    const instance = await SgVendor.query().create({
        type,
        name,
        token,
        urls: urls || {},
        config: finalConfig,
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
    const { type, name, token, urls, config } = body;

    const updatedVendor = await vendorService.updateVendor(vendorId, {
        type,
        name,
        token,
        urls,
        config,
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

    if (await modelService.hasModelsUsingVendor(vendorId)) {
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
    const result = await vendorTestService.testVendorConnectivity(vendor, {
        format: bodyJson.format,
        model: bodyJson.model,
        auto_convert: bodyJson.auto_convert,
    });

    return c.json(result);
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
