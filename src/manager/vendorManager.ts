import { SgVendor } from "../model/sgVendor";
import ormService from "../service/ormService";

interface VendorListOptions {
    type?: string;
    keyword?: string;
    pageSize: number;
    offset: number;
}

async function findById(vendorId: number): Promise<SgVendor | null> {
    return await SgVendor.query().find(vendorId);
}

async function findByName(name: string): Promise<SgVendor | null> {
    if (name == null) {
        return null;
    }

    return await SgVendor.query().where("name", name).first();
}

async function listAll(): Promise<SgVendor[]> {
    return (await SgVendor.query().get()).all();
}

async function list(options: VendorListOptions) {
    const dbQuery = SgVendor.query().orderBy("id", "desc");

    if (options.type) {
        dbQuery.where("type", options.type);
    }

    if (options.keyword) {
        dbQuery.where("name", "like", `%${options.keyword}%`);
    }

    const total = Number(await dbQuery.clone().count() || 0);
    const vendors = await dbQuery.limit(options.pageSize).offset(options.offset).get();
    const vendorList = vendors.all();

    // 每页 vendor 的模型数聚合（单条 GROUP BY 查询）
    const modelCounts: Record<number, number> = {};
    const vendorIds = vendorList.map(v => v.id);
    if (vendorIds.length > 0) {
        const knex = ormService.getKnex();
        const rows: { vendor_id: number; cnt: number }[] = await knex("vendor_model")
            .select(["vendor_id", knex.raw("count(*) as cnt")])
            .whereIn("vendor_id", vendorIds)
            .groupBy("vendor_id");
        rows.forEach(row => {
            modelCounts[Number(row.vendor_id)] = Number(row.cnt);
        });
    }

    return {
        list: vendorList,
        total,
        modelCounts,
    };
}

async function getByIds(ids: number[]): Promise<SgVendor[]> {
    if (ids.length === 0) {
        return [];
    }
    return (await SgVendor.query().whereIn("id", ids).get()).all();
}

async function create(vendor: SgVendor): Promise<SgVendor> {
    await vendor.save();
    return vendor;
}

async function update(vendorId: number, updateData: Record<string, any>): Promise<SgVendor | null> {
    await SgVendor.query().where("id", vendorId).update(updateData);
    return await SgVendor.query().find(vendorId);
}

async function count(): Promise<number> {
    return Number(await SgVendor.query().count() || 0);
}


async function deleteById(vendorId: number): Promise<boolean> {
    const vendor = await SgVendor.query().find(vendorId);
    if (!vendor) {
        return false;
    }

    await SgVendor.query().where("id", vendorId).delete();
    return true;
}

export default {
    findById,
    findByName,
    listAll,
    list,
    getByIds,
    create,
    update,
    count,
    deleteById,
};
