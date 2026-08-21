import type { Builder } from "sutando";
import { SgModel } from "../model/sgModel";

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


async function getModel(modelName: string, enable?: boolean): Promise<SgModel | null> {
    if (modelName == null) return null;

    const query = SgModel.query().where("name", modelName);

    // 如果 enable 参数非空，则按 enable 过滤
    if (enable !== undefined) {
        query.where("enable", enable);
    }

    return await query.first();
}


async function findById(modelId: number): Promise<SgModel | null> {
    return await SgModel.query().find(modelId);
}


async function getByIds(ids: number[]): Promise<SgModel[]> {
    if (ids.length === 0) {
        return [];
    }
    return (await SgModel.query().whereIn("id", ids).get()).all();
}


async function listModels(options: ModelListOptions) {
    const query = SgModel.query().orderBy("id", "desc");
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


async function hasModelsUsingVendor(vendorId: number): Promise<boolean> {
    const query = SgModel.query();
    filterByVendor(query, vendorId);
    return Number(await query.count() || 0) > 0;
}


async function listEnabledModels() {
    const models = await SgModel.query()
        .where("enable", 1)
        .orderBy("id", "asc")
        .get();

    return models.all().map(model => ({
        id: model.name,
        object: "model",
        created: Math.floor(new Date(model.created_at).getTime() / 1000),
        owned_by: "gateway",
    }));
}


async function checkDuplicateModel(
    name: string,
    excludeId?: number,
): Promise<boolean> {
    const query = SgModel.query().where("name", name);
    if (excludeId) {
        query.where("id", "!=", excludeId);
    }
    const existing = await query.first();
    return !!existing;
}


async function count(): Promise<number> {
    return Number(await SgModel.query().count() || 0);
}


async function deleteModel(modelId: number): Promise<boolean> {
    const model = await SgModel.query().find(modelId);

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
    getByIds,
    listModels,
    hasModelsUsingVendor,
    listEnabledModels,
    checkDuplicateModel,
    deleteModel,
    filterByVendor,
    count,
    save,
};
