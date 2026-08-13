import { SgUser } from "../model/sgUser";
import { UserStatus } from "../constants";

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

async function getByIds(ids: number[]): Promise<SgUser[]> {
    if (ids.length === 0) {
        return [];
    }
    return (await SgUser.query().whereIn("id", ids).get()).all();
}

async function list(options: UserListOptions) {
    const dbQuery = SgUser.query().orderBy("id", "desc");

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

async function create(data: Pick<SgUser, "name" | "token" | "type">) {
    return await SgUser.query().create({
        ...data,
        balance: 0,                    // 新用户余额固定 0，由 manager 兜底
        status: UserStatus.ACTIVE,     // 新用户状态固定 ACTIVE，由 manager 兜底
    });
}

async function update(userId: number, data: Record<string, unknown>): Promise<SgUser | null> {
    await SgUser.query().where("id", userId).update(data);
    return await SgUser.query().find(userId);
}

async function updateBalance(userId: number, balance: number): Promise<void> {
    await SgUser.query().where("id", userId).update({ balance });
}

async function count(): Promise<number> {
    return Number(await SgUser.query().count() || 0);
}

export default {
    findByToken,
    findById,
    getByIds,
    list,
    create,
    update,
    updateBalance,
    count,
};
