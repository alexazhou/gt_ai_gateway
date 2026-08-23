import type { Builder } from "sutando";
import { SgModel } from "../model/sgModel";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";

interface ModelListOptions {
    vendorId?: number;
    keyword?: string;
    pageSize: number;
    offset: number;
}


function filterByVendor(query: Builder<SgModel>, vendorId: number): void {
    if (process.env.DB_DRIVER === "mysql") {
        // MySQL 8：JSON_TABLE 展开 upstreams 数组后按 vendor_id 过滤。
        // 注意：须用「外层在 IN 子查询中加入别名」的形式；直接对同表做相关 EXISTS + JSON_TABLE
        // 会在部分 MySQL 版本（如 8.4）报 "Invalid JSON text ... document is empty"。
        query.whereRaw(
            "model.id IN (SELECT sub.id FROM model AS sub, JSON_TABLE(sub.routing_config, '$.upstreams[*]' COLUMNS (vendor_id BIGINT PATH '$.vendor_id')) AS t WHERE t.vendor_id = ?)",
            [vendorId],
        );
    } else {
        // SQLite JSON1：json_each + json_extract
        query.whereRaw(
            "EXISTS (SELECT 1 FROM json_each(model.routing_config, '$.upstreams') AS upstream WHERE json_extract(upstream.value, '$.vendor_id') = ?)",
            [vendorId],
        );
    }
}


// 「本租户模型 ∪ main 租户共享模型」候选条件
function filterByTenantScope(query: Builder<SgModel>, scope: TenantScope): void {
    query.whereRaw(
        "(tenant_id = ? OR (tenant_id = ? AND cross_tenant = 1))",
        [scope.tenantId, scope.mainTenantId],
    );
}


/**
 * 按名称解析模型（LLM 调用）：候选 = 本租户模型 ∪ 共享模型，同名时本租户优先。
 * 必须显式排序（本租户排在共享前），不得依赖 DB 默认顺序。
 */
async function getModel(modelName: string, enable?: boolean, scope?: TenantScope): Promise<SgModel | null> {
    if (modelName == null) return null;

    const query = SgModel.query().where("name", modelName);

    // 如果 enable 参数非空，则按 enable 过滤
    if (enable !== undefined) {
        query.where("enable", enable);
    }

    if (scope) {
        filterByTenantScope(query, scope);
        query.orderByRaw("CASE WHEN tenant_id = ? THEN 0 ELSE 1 END", [scope.tenantId]).orderBy("id", "asc");
    }

    return await query.first();
}


async function findById(modelId: number): Promise<SgModel | null> {
    return await SgModel.query().find(modelId);
}


async function findByIdInTenant(modelId: number, scope: TenantScope): Promise<SgModel | null> {
    const query = SgModel.query().where("id", modelId);
    filterByTenantScope(query, scope);
    return await query.first();
}


async function getByIds(ids: number[], tenantId?: number): Promise<SgModel[]> {
    if (ids.length === 0) {
        return [];
    }
    const q = SgModel.query().whereIn("id", ids);
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    return (await q.get()).all();
}


async function listModels(options: ModelListOptions, scope?: TenantScope) {
    const query = SgModel.query().orderBy("id", "desc");
    if (scope) {
        filterByTenantScope(query, scope);
    }
    if (options.vendorId) {
        filterByVendor(query, options.vendorId);
    }
    if (options.keyword) {
        query.where("name", "like", `%${options.keyword}%`);
    }

    const total = Number(await query.clone().count() || 0);
    const models = await query.limit(options.pageSize).offset(options.offset).get();
    return {
        list: models.all(),
        total,
    };
}


async function hasModelsUsingVendor(vendorId: number, tenantId?: number): Promise<boolean> {
    const query = SgModel.query();
    filterByVendor(query, vendorId);
    if (tenantId !== undefined) {
        query.where("tenant_id", tenantId);
    }
    return Number(await query.count() || 0) > 0;
}


/** /llm/v1/models：按调用方租户过滤 + 并入共享模型，按名称以本租户优先去重 */
async function listEnabledModels(scope?: TenantScope) {
    const query = SgModel.query().where("enable", 1);
    if (scope) {
        filterByTenantScope(query, scope);
        query.orderByRaw("CASE WHEN tenant_id = ? THEN 0 ELSE 1 END", [scope.tenantId]);
    }
    const models = await query.orderBy("id", "asc").get();

    const seen = new Set<string>();
    const result: Array<Record<string, unknown>> = [];
    for (const model of models.all()) {
        if (!model.name || seen.has(model.name)) {
            continue;
        }
        seen.add(model.name);
        result.push({
            id: model.name,
            object: "model",
            created: Math.floor(new Date(model.created_at).getTime() / 1000),
            owned_by: "gateway",
        });
    }
    return result;
}


/** 模型名租户内唯一查重（创建 / 更新 / 启用时按 name + tenant_id） */
async function checkDuplicateModel(
    name: string,
    tenantId?: number,
    excludeId?: number,
): Promise<boolean> {
    const query = SgModel.query().where("name", name);
    if (tenantId !== undefined) {
        query.where("tenant_id", tenantId);
    }
    if (excludeId) {
        query.where("id", "!=", excludeId);
    }
    const existing = await query.first();
    return !!existing;
}


async function count(): Promise<number> {
    return Number(await SgModel.query().count() || 0);
}


async function countByTenant(tenantId: number): Promise<number> {
    return Number(await SgModel.query().where("tenant_id", tenantId).count() || 0);
}


async function deleteModel(modelId: number, tenantId?: number): Promise<boolean> {
    const query = SgModel.query();
    if (tenantId !== undefined) {
        query.where("tenant_id", tenantId);
    }
    const model = await query.where("id", modelId).first();

    if (!model) {
        return false;
    }

    await SgModel.query().where("id", modelId).delete();
    return true;
}


async function save(model: SgModel): Promise<SgModel> {
    await model.save();
    return model;
}

export default {
    getModel,
    findById,
    findByIdInTenant,
    getByIds,
    listModels,
    hasModelsUsingVendor,
    listEnabledModels,
    checkDuplicateModel,
    deleteModel,
    filterByVendor,
    count,
    countByTenant,
    save,
};
