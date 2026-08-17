import SgClientConfig from "../model/sgClientConfig";

async function listByClient(client: string, orderByIdAsc = true): Promise<SgClientConfig[]> {
    const q = SgClientConfig.query().where("client", client);
    if (orderByIdAsc) {
        q.orderBy("id", "asc");
    }
    return (await q.get()).all();
}

/**
 * 按 id + client 查找，确保记录归属该客户端；不存在时返回 null。
 */
async function findByIdAndClient(backupId: number, client: string): Promise<SgClientConfig | null> {
    return await SgClientConfig.query()
        .where("id", backupId)
        .where("client", client)
        .first();
}

async function create(data: Record<string, any>) {
    return await SgClientConfig.query().create(data);
}

async function update(record: SgClientConfig, data: Record<string, any>): Promise<SgClientConfig> {
    await record.update(data);
    return record;
}

async function remove(record: SgClientConfig): Promise<void> {
    await record.delete();
}

async function disableAllByClient(client: string): Promise<void> {
    await SgClientConfig.query().where("client", client).update({ enabled: false });
}

/**
 * 生成不重复的配置名：已存在同名时追加递增序号。
 */
async function formatUniqueName(client: string, baseName: string): Promise<string> {
    const records = await listByClient(client);
    const existingNames = new Set(records.map(record => String(record.name)));
    if (!existingNames.has(baseName)) {
        return baseName;
    }

    let index = 1;
    while (existingNames.has(`${baseName}${index}`)) {
        index += 1;
    }

    return `${baseName}${index}`;
}

export default {
    listByClient,
    findByIdAndClient,
    create,
    update,
    remove,
    disableAllByClient,
    formatUniqueName,
};
