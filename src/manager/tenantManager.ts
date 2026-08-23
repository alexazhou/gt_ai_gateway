import SgTenant from "../model/sgTenant";

interface TenantListOptions {
    keyword?: string;
    pageSize: number;
    offset: number;
}


async function list(options: TenantListOptions) {
    const query = SgTenant.query().orderBy("id", "asc");
    if (options.keyword) {
        query.where("name", "like", `%${options.keyword}%`);
    }

    const total = Number(await query.clone().count() || 0);
    const tenants = await query.limit(options.pageSize).offset(options.offset).get();
    return {
        list: tenants.all(),
        total,
    };
}


async function findById(tenantId: number): Promise<SgTenant | null> {
    return await SgTenant.query().find(tenantId);
}


async function findByName(name: string): Promise<SgTenant | null> {
    if (name == null) {
        return null;
    }
    return await SgTenant.query().where("name", name).first();
}


async function create(data: { name: string; description?: string | null }): Promise<SgTenant> {
    return await SgTenant.query().create({
        name: data.name,
        description: data.description ?? null,
    });
}


async function update(tenantId: number, updateData: Record<string, any>): Promise<SgTenant | null> {
    await SgTenant.query().where("id", tenantId).update(updateData);
    return await SgTenant.query().find(tenantId);
}


async function deleteById(tenantId: number): Promise<boolean> {
    const tenant = await SgTenant.query().find(tenantId);
    if (!tenant) {
        return false;
    }
    await SgTenant.query().where("id", tenantId).delete();
    return true;
}


async function count(): Promise<number> {
    return Number(await SgTenant.query().count() || 0);
}

export default {
    list,
    findById,
    findByName,
    create,
    update,
    deleteById,
    count,
};
