import userManager from "../../manager/userManager";
import type { ConfigAdapter, FileSystemApi, GatewayUserInfo, AdapterConfigStatus } from "./types";
import fsUtil from "../../util/fsUtil";


async function pathExists(path: string): Promise<boolean> {
    return fsUtil.pathExists(path);
}


function parseJsonConfig(content: string): Record<string, any> {
    if (!content.trim()) {
        return {};
    }

    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Config file must contain a JSON object");
    }

    return parsed;
}


async function findGatewayUserByToken(token: string): Promise<GatewayUserInfo | null> {
    if (!token) {
        return null;
    }

    const normalizedToken = token.replace(/^Bearer\s+/i, "");
    let user;
    try {
        user = await userManager.findByToken(normalizedToken);
    } catch {
        return null;
    }

    if (!user) {
        return null;
    }

    return {
        id: user.id,
        name: user.name,
        type: user.type,
        status: user.status,
    };
}


async function buildClientStatus(adapter: ConfigAdapter): Promise<AdapterConfigStatus> {
    const installed = await adapter.isInstalled();
    let configured = false;
    let message: string | undefined;
    let currentConfig = null;

    if (installed && await pathExists(adapter.configPaths[0])) {
        try {
            currentConfig = adapter.parseConfigFileContent(await adapter.readConfig());
            configured = Boolean(currentConfig);
        } catch (error) {
            message = `配置文件解析失败: ${String(error)}`;
        }
    }

    return {
        client: adapter.client,
        displayName: adapter.displayName,
        protocol: adapter.protocol,
        defaultGatewaySuffix: adapter.defaultGatewaySuffix,
        installed,
        configured,
        currentConfig,
        configPaths: adapter.configPaths,
        message,
    };
}


export default {
    findGatewayUserByToken,
    parseJsonConfig,
    pathExists,
    buildClientStatus,
};
