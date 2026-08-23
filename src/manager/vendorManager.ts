import { SgVendor } from "../model/sgVendor";
import ormService from "../service/ormService";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";

interface VendorListOptions {
    type?: string;
    keyword?: string;
    pageSize: number;
    offset: number;
}

async function findById(vendorId: number): Promise<SgVendor | null> {
    return await SgVendor.query().find(vendorId);
}

async function findByIdInTenant(vendorId: number, tenantId: number): Promise<SgVendor | null> {
    return await SgVendor.query().where("id", vendorId).where("tenant_id", tenantId).first();
}

async function findByName(name: string, tenantId?: number): Promise<SgVendor | null> {
    if (name == null) {
        return null;
    }

    const q = SgVendor.query().where("name", name);
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    return await q.first();
}

async function listAll(): Promise<SgVendor[]> {
    return (await SgVendor.query().get()).all();
}

async function list(options: VendorListOptions, scope?: TenantScope) {
    const dbQuery = SgVendor.query().orderBy("id", "desc");

    if (scope) {
        dbQuery.where("tenant_id", scope.tenantId);
    }

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

async function getByIds(ids: number[], tenantId?: number): Promise<SgVendor[]> {
    if (ids.length === 0) {
        return [];
    }
    const q = SgVendor.query().whereIn("id", ids);
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    return (await q.get()).all();
}

async function create(vendor: SgVendor): Promise<SgVendor> {
    await vendor.save();
    return vendor;
}

async function update(vendorId: number, updateData: Record<string, any>, tenantId?: number): Promise<SgVendor | null> {
    const q = SgVendor.query();
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    const affected = await q.where("id", vendorId).update(updateData);
    if (affected === 0) {
        return null;
    }
    return await SgVendor.query().find(vendorId);
}

async function count(): Promise<number> {
    return Number(await SgVendor.query().count() || 0);
}

async function countByTenant(tenantId: number): Promise<number> {
    return Number(await SgVendor.query().where("tenant_id", tenantId).count() || 0);
}


async function deleteById(vendorId: number, tenantId?: number): Promise<boolean> {
    const q = SgVendor.query();
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    const vendor = await q.where("id", vendorId).first();
    if (!vendor) {
        return false;
    }

    await SgVendor.query().where("id", vendorId).delete();
    return true;
}

export default {
    findById,
    findByIdInTenant,
    findByName,
    listAll,
    list,
    getByIds,
    create,
    update,
    count,
    countByTenant,
    deleteById,
};
