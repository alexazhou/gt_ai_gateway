import { Context } from "hono";
import { ConfigKey } from "../constants";
import configService from "../service/configService";
import hostService from "../service/hostService";
import customError from "../customError";

async function getConfig(c: Context) {
    await hostService.getHostKey();
    return c.json(await configService.getAll());
}

async function updateConfig(c: Context) {
    const body = await c.req.json();

    // 多租户隔离是全局开关：改值仅限系统管理员（前端同样只对系统管理员开放该开关）。
    // 只比对「是否真的改值」而非「是否携带该字段」——否则非系统管理员顺带提交整份配置时，
    // 改其它配置项（如 host_key）也会被连带拒绝。
    if (body !== null && typeof body === "object" && ConfigKey.MULTI_TENANT_ENABLED in body) {
        const current = (await configService.getConfig(ConfigKey.MULTI_TENANT_ENABLED)).getString();
        const changed = String(body[ConfigKey.MULTI_TENANT_ENABLED]) !== current;
        if (changed && !c.get("tenantScope")?.isSystemAdmin) {
            throw new customError.AppError("Only system administrators can change multi-tenant isolation", 403);
        }
    }

    return c.json(await configService.updateAll(body));
}

export default {
    getConfig,
    updateConfig,
};
