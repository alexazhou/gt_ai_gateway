import { SgConfig } from "../model/sgConfig";

async function get(name: string): Promise<SgConfig | null> {
    return await SgConfig.query().where("name", name).first();
}

/**
 * 按 name 更新或插入配置项，返回最终记录。
 */
async function set(name: string, value: string): Promise<SgConfig> {
    const config = await get(name);

    if (config) {
        await config.update({ value });
        return config;
    }

    return await SgConfig.query().create({ name, value });
}

async function getAll(): Promise<SgConfig[]> {
    return (await SgConfig.query().get()).all();
}

export default {
    get,
    set,
    getAll,
};
