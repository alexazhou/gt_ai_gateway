import { SgVendorModel } from "../model/sgVendorModel";
import customError from "../customError";

async function listByVendor(vendorId: number): Promise<SgVendorModel[]> {
    return (await SgVendorModel.query()
        .where("vendor_id", vendorId)
        .orderBy("model_id", "asc")
        .get()).all();
}

async function findById(recordId: number): Promise<SgVendorModel | null> {
    return await SgVendorModel.query().find(recordId);
}

/**
 * 按 vendor + model_id 查找；不存在时返回 null。
 */
async function findByVendorAndModel(vendorId: number, modelId: string | null): Promise<SgVendorModel | null> {
    return await SgVendorModel.query()
        .where("vendor_id", vendorId)
        .where("model_id", modelId)
        .first();
}

/**
 * 直接插入一条 vendor model（不做重复检查，供路由自动补全等场景使用）。
 */
async function create(vendorId: number, modelId: string): Promise<SgVendorModel> {
    return await SgVendorModel.query().create({
        vendor_id: vendorId,
        model_id: modelId,
    });
}

/**
 * 同步该 vendor 下的模型列表：先删除旧记录，再重新插入选中的 model_id。
 * @returns 同步后的完整模型列表（按 model_id 升序）
 */
async function syncByVendor(vendorId: number, modelIds: string[]): Promise<SgVendorModel[]> {
    await SgVendorModel.query().where("vendor_id", vendorId).delete();

    if (modelIds.length > 0) {
        for (const modelId of modelIds) {
            await SgVendorModel.query().create({
                vendor_id: vendorId,
                model_id: modelId,
            });
        }
    }

    return await listByVendor(vendorId);
}

/**
 * 新增 vendor model；同 vendor 下 model_id 已存在时抛 409。
 */
async function add(vendorId: number, modelId: string): Promise<SgVendorModel> {
    const existing = await SgVendorModel.query()
        .where("vendor_id", vendorId)
        .where("model_id", modelId)
        .first();

    if (existing) {
        throw new customError.AppError("Model already exists", 409);
    }

    return await SgVendorModel.query().create({
        vendor_id: vendorId,
        model_id: modelId,
    });
}

/**
 * 更新指定 vendor model 的 allowed_formats；记录不存在（或不属于该 vendor）时返回 null。
 */
async function update(
    recordId: number,
    vendorId: number,
    allowedFormatsJson: string | null,
): Promise<SgVendorModel | null> {
    const record = await findVendorModel(recordId, vendorId);
    if (!record) {
        return null;
    }

    await SgVendorModel.query().where("id", recordId).update({ allowed_formats: allowedFormatsJson });

    return await SgVendorModel.query().find(recordId);
}

/**
 * 删除指定 vendor model；记录不存在（或不属于该 vendor）时返回 false。
 */
async function remove(recordId: number, vendorId: number): Promise<boolean> {
    const record = await findVendorModel(recordId, vendorId);
    if (!record) {
        return false;
    }

    await SgVendorModel.query().where("id", recordId).delete();
    return true;
}

async function getByIds(ids: number[], tenantId?: number): Promise<SgVendorModel[]> {
    if (ids.length === 0) {
        return [];
    }
    const q = SgVendorModel.query().whereIn("id", ids);
    if (tenantId !== undefined) {
        // vendor_model 经 vendor 间接隔离
        q.whereRaw("vendor_id IN (SELECT id FROM vendor WHERE tenant_id = ?)", [tenantId]);
    }
    return (await q.get()).all();
}

/**
 * 按 id + vendor_id 查找，确保记录归属该 vendor。
 */
async function findVendorModel(recordId: number, vendorId: number): Promise<SgVendorModel | null> {
    return await SgVendorModel.query()
        .where("id", recordId)
        .where("vendor_id", vendorId)
        .first();
}

export default {
    listByVendor,
    findById,
    findByVendorAndModel,
    create,
    syncByVendor,
    add,
    update,
    remove,
    getByIds,
    findVendorModel,
};
