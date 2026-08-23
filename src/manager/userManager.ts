import { SgUser } from "../model/sgUser";
import { UserStatus } from "../constants";
import type { TenantScope } from "../middleware/tenantScopeMiddleware";

interface UserListOptions {
    type?: string;
    keyword?: string;
    pageSize: number;
    offset: number;
}

async function findByToken(token: string): Promise<SgUser | null> {
    if (token == null) return null;

    return await SgUser.query().where("token", token).first();
}

async function findById(userId: number): Promise<SgUser | null> {
    return await SgUser.query().find(userId);
}

async function findByIdInTenant(userId: number, tenantId: number): Promise<SgUser | null> {
    return await SgUser.query().where("id", userId).where("tenant_id", tenantId).first();
}

async function getByIds(ids: number[], tenantId?: number): Promise<SgUser[]> {
    if (ids.length === 0) {
        return [];
    }
    const q = SgUser.query().whereIn("id", ids);
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    return (await q.get()).all();
}

async function list(options: UserListOptions, scope?: TenantScope) {
    const dbQuery = SgUser.query().orderBy("id", "desc");

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
    const users = await dbQuery.limit(options.pageSize).offset(options.offset).get();
    return {
        list: users.all(),
        total,
    };
}

async function create(data: Pick<SgUser, "name" | "token" | "type">, tenantId?: number) {
    return await SgUser.query().create({
        ...data,
        tenant_id: tenantId ?? null,
        balance: 0,                    // 新用户余额固定 0，由 manager 兜底
        status: UserStatus.ACTIVE,     // 新用户状态固定 ACTIVE，由 manager 兜底
    });
}

async function update(userId: number, data: Record<string, unknown>): Promise<SgUser | null> {
    await SgUser.query().where("id", userId).update(data);
    return await SgUser.query().find(userId);
}

// 原子增量更新：由数据库执行 balance = balance + delta，避免「先读后写」的并发丢更新
async function incrementBalance(userId: number, delta: number): Promise<void> {
    await SgUser.query().where("id", userId).increment("balance", delta);
}

async function count(): Promise<number> {
    return Number(await SgUser.query().count() || 0);
}

async function countByTenant(tenantId: number): Promise<number> {
    return Number(await SgUser.query().where("tenant_id", tenantId).count() || 0);
}

export default {
    findByToken,
    findById,
    findByIdInTenant,
    getByIds,
    list,
    create,
    update,
    incrementBalance,
    count,
    countByTenant,
};
