import { Context } from "hono";
import configService from "../service/configService";

async function getConfig(c: Context) {
    return c.json(await configService.getAll());
}

async function updateConfig(c: Context) {
    const body = await c.req.json();
    return c.json(await configService.updateAll(body));
}

export default {
    getConfig,
    updateConfig,
};
