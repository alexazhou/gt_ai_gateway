import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";
import vendorManager from "../manager/vendorManager";
import vendorService from "../service/vendorService";
import vendorDefaultUrls from "../util/vendorDefaultUrlsUtil";
import vendorTestService from "../service/vendorTestService";
import modelManager from "../manager/modelManager";
import customError from "../customError";
import maskUtil from "../util/maskUtil";
import inputSanitizeUtil from "../util/inputSanitizeUtil";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";


/**
 * 回传给前端的 vendor 配置：代理 URL 里的账号密码必须掩码，凭据不出后端。
 */
function maskVendorConfig(config: SgVendor["config"] | null | undefined): unknown {
    if (config == null) {
        return config;
    }
    // Sutando 自定义 cast 实例需先转普通对象，否则改动会回写到模型上
    const plain = typeof (config as { toJSON?: () => unknown }).toJSON === "function"
        ? (config as { toJSON: () => Record<string, unknown> }).toJSON()
        : config;
    const result = { ...plain } as Record<string, unknown>;
    const proxy = result.proxy as { type?: string; url?: string } | null | undefined;
    if (proxy && typeof proxy.url === "string") {
        result.proxy = { ...proxy, url: maskUtil.maskUrlCredentials(proxy.url) };
    }
    return result;
}


/**
 * Format vendor for API response (parse URLs using model method)
 *
 * token 默认掩码（只留前 4 位）：明文凭据不允许通过常规查询接口回传。
 * 需要明文的场景（如重新复制 key）走独立的高权限接口 + 审计，不复用这里。
 */
function formatVendor(vendor: SgVendor, modelCount = 0) {
    return {
        id: vendor.id,
        type: vendor.type,
        name: vendor.name,
        token: maskUtil.maskToken(vendor.token),
        urls: vendor.urls,
        config: maskVendorConfig(vendor.config),
        model_count: modelCount,
        created_at: vendor.created_at,
        updated_at: vendor.updated_at,
    };
}


async function listVendors(c: Context) {
    const scope = c.get("tenantScope")!;
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);

    const { list: vendors, total, modelCounts } = await vendorManager.list({
        type: query.type,
        keyword: query.keyword,
        pageSize,
        offset,
    }, scope);

    const formattedVendors = vendors.map(v => formatVendor(v, modelCounts[v.id] ?? 0));
    return c.json(createListResponse(formattedVendors, total));
}


async function getVendor(c: Context) {
    const scope = c.get("tenantScope")!;
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await vendorManager.findByIdInTenant(vendorId, scope.tenantId);

    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    return c.json(formatVendor(vendor));
}

async function getVendorsByIds(c: Context) {
    const scope = c.get("tenantScope")!;
    const body = await c.req.json();
    const ids = body.ids;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return c.json([]);
    }

    const idList = ids.map(id => parseInt(String(id), 10)).filter(id => !isNaN(id));
    if (idList.length === 0) {
        return c.json([]);
    }

    const vendors = await vendorManager.getByIds(idList, scope.tenantId);
    const formattedVendors = vendors.map(formatVendor);
    return c.json(formattedVendors);
}


async function createVendor(c: Context) {
    const scope = c.get("tenantScope")!;
    const body = await c.req.json();
    // 同 P2-26：畸形键会在 fill() 里炸成 500，先剔掉
    const vendor = new SgVendor(inputSanitizeUtil.stripUnsafeKeys(body as Record<string, unknown>));

    // Validation - 不验证 urls，允许为空
    if (!vendor.type || !vendor.name || !vendor.token) {
        throw new customError.AppError("Missing required fields");
    }

    // 归属由服务端写入，客户端 body 中的 tenant_id 忽略；供应商名租户内唯一
    vendor.tenant_id = scope.tenantId;
    const dup = await vendorManager.findByName(vendor.name, scope.tenantId);
    if (dup) {
        throw new customError.AppError("A vendor with this name already exists", 409);
    }

    vendorService.validateProxyConfig(vendor.config);

    const instance = await vendorManager.create(vendor);

    return c.json(formatVendor(instance));
}


async function updateVendor(c: Context) {
    const scope = c.get("tenantScope")!;
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
    }, scope.tenantId);

    if (!updatedVendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    return c.json(formatVendor(updatedVendor));
}


async function deleteVendor(c: Context) {
    const scope = c.get("tenantScope")!;
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await vendorManager.findByIdInTenant(vendorId, scope.tenantId);

    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    if (await modelManager.hasModelsUsingVendor(vendorId, scope.tenantId)) {
        throw new customError.AppError("Cannot delete vendor with associated models");
    }

    const deleted = await vendorManager.deleteById(vendorId, scope.tenantId);
    if (!deleted) {
        throw new customError.NotFoundError("Vendor not found");
    }

    return c.json({ success: true });
}

async function testVendor(c: Context) {
    const scope = c.get("tenantScope")!;
    const id = c.req.param("id");
    const vendorId = parseInt(id, 10);

    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await vendorManager.findByIdInTenant(vendorId, scope.tenantId);
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
