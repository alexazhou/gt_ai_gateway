import { Context } from "hono";
import { ClientName } from "../constants";
import clientConfigService from "../service/clientConfigService/core";


function isClientName(value: string): value is ClientName {
    return value === ClientName.CLAUDE_CODE || value === ClientName.CODEX;
}


async function status(c: Context) {
    return c.json(await clientConfigService.getStatus());
}


async function create(c: Context) {
    const body = await c.req.json();
    return c.json(await clientConfigService.createConfig(body));
}


async function backup(c: Context) {
    const body = await c.req.json();
    return c.json(await clientConfigService.createBackup(body));
}


async function renameBackup(c: Context) {
    const body = await c.req.json();
    return c.json(await clientConfigService.renameBackup(body));
}


async function deleteBackup(c: Context) {
    const body = await c.req.json();
    return c.json(await clientConfigService.deleteBackup(body));
}


async function apply(c: Context) {
    const body = await c.req.json();
    return c.json(await clientConfigService.applyConfig(body));
}

async function updateBackup(c: Context) {
    const body = await c.req.json();
    return c.json(await clientConfigService.updateBackupConfig(body));
}

async function readLocal(c: Context) {
    const client = c.req.query('client');
    if (!client || !isClientName(client)) {
        return c.json({ error: 'client is required' }, 400);
    }
    return c.json(await clientConfigService.readLocalConfig(client));
}

async function syncFromLocal(c: Context) {
    const body = await c.req.json();
    return c.json(await clientConfigService.syncFromLocal(body));
}

export default {
    backup,
    create,
    deleteBackup,
    readLocal,
    renameBackup,
    status,
    apply,
    syncFromLocal,
    updateBackup,
};
