import ormService from "../ormService";
import SgClientConfig from "../../model/sgClientConfig";
import vendorService from "../vendorService";
import clientConfigManager from "../../manager/clientConfigManager";
import vendorManager from "../../manager/vendorManager";
import userManager from "../../manager/userManager";
import { ClientName, ConnectionMode } from "../../constants";
import type {
    ApplyClientConfigParams,
    ClientConfigBackupInfo,
    ClientConfigStatus,
    ClientConfigStatusResponse,
    ConfigAdapter,
    CreateClientConfigBackupParams,
    CreateClientConfigParams,
    DeleteClientConfigBackupParams,
    RenameClientConfigBackupParams,
    UpdateClientConfigBackupParams,
    AdapterConfigStatus,
    ClientConfigContent,
    CurrentClientConfigWithUser,
} from "./types";
import ClaudeCodeConfigAdapter from "./claudeCodeConfigAdapter";
import CodexConfigAdapter from "./codexConfigAdapter";
import configAdapterUtils from "./configAdapterUtils";


function getHomeDir(): string {
    return process.env.HOME || process.env.USERPROFILE || "";
}


async function getAdapters(): Promise<ConfigAdapter[]> {
    const homeDir = getHomeDir();
    if (!homeDir) {
        throw new Error("Cannot determine user home directory");
    }

    return [
        new ClaudeCodeConfigAdapter(homeDir),
        new CodexConfigAdapter(homeDir),
    ];
}


async function getAdapter(client: ClientName): Promise<ConfigAdapter> {
    const adapters = await getAdapters();
    const adapter = adapters.find(item => item.client === client);
    if (!adapter) {
        throw new Error(`Unsupported client: ${client}`);
    }

    return adapter;
}


function isEnabled(value: unknown): boolean {
    return value === true || value === 1 || value === "1";
}


async function enrichGatewayUser(config: ClientConfigContent | null): Promise<CurrentClientConfigWithUser | null> {
    if (!config) {
        return null;
    }
    const gatewayUser = await configAdapterUtils.findGatewayUserByToken(config.apiKey);
    return {
        ...config,
        configPaths: [],
        gatewayUser,
    };
}


function extractFieldsFromBackup(backupContent: any, adapter: ConfigAdapter): ClientConfigContent | null {
    if (!backupContent || typeof backupContent !== "object") return null;

    // New format: backup contains gatewayUrl or connectionMode fields
    if ("gatewayUrl" in backupContent || "connectionMode" in backupContent) {
        const config = backupContent as ClientConfigContent;

        // Verify backup content using adapter-specific validation
        if (adapter.verifyClientConfigContent && !adapter.verifyClientConfigContent(config)) {
            return null;
        }

        return config;
    }

    // Legacy format: backup contains raw config file content
    return adapter.parseConfigFileContent(backupContent);
}

async function toBackupInfo(record: SgClientConfig, adapter: ConfigAdapter): Promise<ClientConfigBackupInfo> {
    const rawContent = record.configContent || {};
    const parsedConfig = extractFieldsFromBackup(rawContent, adapter);

    if (parsedConfig?.connectionMode === ConnectionMode.VENDOR && parsedConfig.gatewayUrl) {
        (parsedConfig as any).matchedVendorId = await vendorService.findVendorByUrl(parsedConfig.gatewayUrl, adapter.protocol);
    }

    return {
        id: Number(record.id),
        client: record.client as ClientName,
        name: record.name,
        fileCount: 1, // simplified since we just store fields now
        createdAt: String(record.created_at || ""),
        enabled: isEnabled(record.enabled),
        config: await enrichGatewayUser(parsedConfig),
        matchedVendorId: (parsedConfig as any)?.matchedVendorId ?? null,
    };
}


function normalizeBackupRecords(records: any): any[] {
    if (Array.isArray(records)) {
        return records;
    }

    if (Array.isArray(records?.items)) {
        return records.items;
    }

    if (typeof records?.toData === "function") {
        const data = records.toData();
        return Array.isArray(data) ? data : [];
    }

    return [];
}


async function getBackups(client: ClientName, adapter: ConfigAdapter): Promise<ClientConfigBackupInfo[]> {
    const records = await clientConfigManager.listByClient(client);

    return await Promise.all(records.map(record => toBackupInfo(record, adapter)));
}


async function enrichStatus(adapterStatus: AdapterConfigStatus, adapter: ConfigAdapter): Promise<ClientConfigStatus> {
    const records = await clientConfigManager.listByClient(adapterStatus.client);

    const backupRecords = normalizeBackupRecords(records);
    const backups = await Promise.all(backupRecords.map(record => toBackupInfo(record, adapter)));
    const activeRecord = backupRecords.find(record => isEnabled(record.enabled));
    const activeBackupId = activeRecord ? Number(activeRecord.id) : undefined;

    let activeBackupInvalid = false;
    let activeConfigModified = false;
    if (activeRecord) {
        const currentContent = await adapter.readConfig();
        const activeConfig = extractFieldsFromBackup(activeRecord.configContent, adapter);
        const currentConfig = adapter.parseConfigFileContent(currentContent);

        // Check if config file is corrupted (e.g., duplicate fields, reserved provider ID conflict)
        const isCorrupted = adapter.isConfigCorrupted && adapter.isConfigCorrupted(currentContent);

        if (!activeConfig) {
            // Backup is invalid (cannot be parsed)
            activeBackupInvalid = true;
        } else if (!currentConfig) {
            // Backup is valid but local config cannot be parsed
            // Only mark as modified if the config is actually corrupted
            if (isCorrupted) {
                activeConfigModified = true;
            }
        } else if (isCorrupted) {
            // Both are valid but config is corrupted
            activeConfigModified = true;
        } else {
            // Both are valid, compare the fields
            const serializeRelevant = (c: ClientConfigContent) => JSON.stringify({
                connectionMode: c.connectionMode,
                gatewayUrl: c.gatewayUrl,
                apiKey: c.apiKey,
                model: c.model,
            });
            activeConfigModified = serializeRelevant(activeConfig) !== serializeRelevant(currentConfig);
        }
    }

    const currentConfigWithUser = await enrichGatewayUser(adapterStatus.currentConfig);

    return {
        ...adapterStatus,
        currentConfig: currentConfigWithUser,
        backupExists: backups.length > 0,
        backupCount: backups.length,
        backups,
        activeBackupId,
        activeBackupInvalid,
        activeConfigModified,
    };
}


async function getStatus(): Promise<ClientConfigStatusResponse> {
    if (ormService.isWorker) {
        return {
            available: false,
            reason: "客户端管理需要读写本机配置文件，请本地安装后使用。",
            clients: [],
        };
    }

    const adapters = await getAdapters();
    const clients = await Promise.all(adapters.map(async (adapter) => {
        const adapterStatus = await configAdapterUtils.buildClientStatus(adapter);
        return await enrichStatus(adapterStatus, adapter);
    }));
    return {
        available: true,
        clients,
    };
}


async function resolveApiKey(connectionMode?: ConnectionMode, vendorId?: number, userId?: number): Promise<string> {
    if (connectionMode === ConnectionMode.VENDOR && vendorId) {
        const vendor = await vendorManager.findById(vendorId);
        if (vendor?.token) return vendor.token;
    }
    if (connectionMode === ConnectionMode.GATEWAY && userId) {
        const user = await userManager.findById(userId);
        if (user?.token) return user.token;
    }
    return '';
}


async function resolveConfigApiKey(
    connectionMode: ConnectionMode,
    apiKey?: string,
    vendorId?: number,
    userId?: number,
): Promise<string> {
    if (connectionMode === ConnectionMode.OFFICIAL) {
        return apiKey?.trim() || "";
    }

    return await resolveApiKey(connectionMode, vendorId, userId);
}


async function createConfig(params: CreateClientConfigParams): Promise<ClientConfigStatus> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }

    const resolvedMode = params.connectionMode || ConnectionMode.GATEWAY;

    // Skip validation for OFFICIAL mode (no gatewayUrl or apiKey required)
    if (resolvedMode !== ConnectionMode.OFFICIAL) {
        if (!params.gatewayUrl?.trim()) {
            throw new Error("Gateway URL is required");
        }

        if (resolvedMode === ConnectionMode.VENDOR) {
            if (!params.vendorId) {
                throw new Error("Vendor is required");
            }
        } else if (resolvedMode === ConnectionMode.GATEWAY) {
            if (!params.userId) {
                throw new Error("User is required");
            }
        }
    }

    const adapter = await getAdapter(params.client);
    const existingContent = await adapter.readConfig();

    const apiKey = await resolveConfigApiKey(resolvedMode, params.apiKey, params.vendorId, params.userId);

    // For Codex OFFICIAL mode, read authJson from local config and update access_token
    let authJson: Record<string, any> | undefined;
    if (params.client === ClientName.CODEX && resolvedMode === ConnectionMode.OFFICIAL) {
        const authContent = existingContent[adapter.configPaths[1]];
        if (authContent) {
            try {
                const parsed = JSON.parse(authContent);
                // Only use authJson if it has tokens with id_token
                if (parsed?.tokens?.id_token) {
                    authJson = parsed;
                    authJson!.tokens.access_token = apiKey;
                }
            } catch (e) {
                // Ignore parsing errors
            }
        }
    }

    const fields: ClientConfigContent = {
        version: "v1",
        connectionMode: resolvedMode,
        gatewayUrl: params.gatewayUrl?.trim() || "",
        apiKey,
        model: params.model?.trim() || "",
        effortLevel: params.effortLevel?.trim(),
        authJson,
    };
    
    await clientConfigManager.create({
        client: params.client,
        name: await clientConfigManager.formatUniqueName(params.client, "未命名配置"),
        configContent: fields,
        enabled: false,
    });

    const adapterStatus = await configAdapterUtils.buildClientStatus(adapter);
    return await enrichStatus(adapterStatus, adapter);
}


async function createBackup(params: CreateClientConfigBackupParams): Promise<ClientConfigBackupInfo> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }

    const adapter = await getAdapter(params.client);
    let fields = params.configContent;
    if (!fields) {
        const configContent = await adapter.readConfig();
        fields = adapter.parseConfigFileContent(configContent) || { version: "v1", connectionMode: ConnectionMode.OFFICIAL, gatewayUrl: "", apiKey: "", model: "" };
    } else if (fields.connectionMode && fields.connectionMode !== ConnectionMode.OFFICIAL) {
        const apiKey = await resolveApiKey(fields.connectionMode, fields.vendorId, fields.userId);
        if (apiKey) fields.apiKey = apiKey;
    }
    const record = await clientConfigManager.create({
        client: params.client,
        name: params.name?.trim() || await clientConfigManager.formatUniqueName(params.client, "未命名配置"),
        configContent: fields,
        enabled: false,
    });

    if (params.enabled) {
        await enableBackup(params.client, record);
    }

    return await toBackupInfo(record, adapter);
}


async function renameBackup(params: RenameClientConfigBackupParams): Promise<ClientConfigBackupInfo> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }

    const name = params.name?.trim();
    if (!name) {
        throw new Error("Backup name is required");
    }

    const backup = await clientConfigManager.findByIdAndClient(params.backupId, params.client);

    if (!backup) {
        throw new Error("Backup not found");
    }

    await clientConfigManager.update(backup, { name });
    backup.name = name;
    return await toBackupInfo(backup, await getAdapter(params.client));
}


async function updateBackupConfig(params: UpdateClientConfigBackupParams): Promise<ClientConfigStatus> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }

    const resolvedMode = params.connectionMode || ConnectionMode.GATEWAY;

    // Skip validation for OFFICIAL mode (no gatewayUrl or apiKey required)
    if (resolvedMode !== ConnectionMode.OFFICIAL) {
        if (!params.gatewayUrl?.trim()) {
            throw new Error("Gateway URL is required");
        }

        if (resolvedMode === ConnectionMode.VENDOR) {
            if (!params.vendorId) {
                throw new Error("Vendor is required");
            }
        } else if (resolvedMode === ConnectionMode.GATEWAY) {
            if (!params.userId) {
                throw new Error("User is required");
            }
        }
    }

    const adapter = await getAdapter(params.client);
    const backup = await clientConfigManager.findByIdAndClient(params.backupId, params.client);

    if (!backup) {
        throw new Error("Backup not found");
    }

    const apiKey = await resolveConfigApiKey(resolvedMode, params.apiKey, params.vendorId, params.userId);

    const fields: ClientConfigContent = {
        version: "v1",
        connectionMode: resolvedMode,
        gatewayUrl: params.gatewayUrl?.trim() || "",
        apiKey,
        model: params.model?.trim() || "",
        effortLevel: params.effortLevel?.trim(),
    };

    await clientConfigManager.update(backup, { configContent: fields });
    backup.configContent = fields as any;

    if (backup.enabled) {
        // If the backup being updated is currently enabled, apply changes to local config immediately
        // BUT we must patch the current local file to preserve any manual additions like mcpServers!
        const currentContent = await adapter.readConfig();
        const patchedContent = adapter.patchConfigFileContent(currentContent, fields);
        await adapter.writeConfig(patchedContent);
    }

    const adapterStatus = await configAdapterUtils.buildClientStatus(adapter);
    return await enrichStatus(adapterStatus, adapter);
}


async function syncFromLocal(params: { client: ClientName; backupId: number }): Promise<ClientConfigStatus> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }
    const adapter = await getAdapter(params.client);
    const backup = await clientConfigManager.findByIdAndClient(params.backupId, params.client);
    if (!backup) {
        throw new Error("Backup not found");
    }
    const configContent = await adapter.readConfig();
    const fields = adapter.parseConfigFileContent(configContent) || { version: "v1", connectionMode: ConnectionMode.OFFICIAL, gatewayUrl: "", apiKey: "", model: "" };
    await clientConfigManager.update(backup, { configContent: fields });
    const adapterStatus = await configAdapterUtils.buildClientStatus(adapter);
    return await enrichStatus(adapterStatus, adapter);
}


async function deleteBackup(params: DeleteClientConfigBackupParams): Promise<ClientConfigStatus> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }

    const adapter = await getAdapter(params.client);
    const backup = await clientConfigManager.findByIdAndClient(params.backupId, params.client);

    if (!backup) {
        throw new Error("Backup not found");
    }

    await clientConfigManager.remove(backup);
    const adapterStatus = await configAdapterUtils.buildClientStatus(adapter);
    return await enrichStatus(adapterStatus, adapter);
}


async function enableBackup(client: ClientName, backup: SgClientConfig): Promise<void> {
    await clientConfigManager.disableAllByClient(client);
    await clientConfigManager.update(backup, { enabled: true });
    backup.enabled = true;
}


async function readLocalConfig(client: ClientName): Promise<ClientConfigContent> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }
    const adapter = await getAdapter(client);
    const configContent = await adapter.readConfig();
    const fields = adapter.parseConfigFileContent(configContent) || { version: "v1", connectionMode: ConnectionMode.OFFICIAL, gatewayUrl: "", apiKey: "", model: "" };
    if (fields.connectionMode === ConnectionMode.VENDOR && fields.gatewayUrl) {
        (fields as any).matchedVendorId = await vendorService.findVendorByUrl(fields.gatewayUrl, adapter.protocol);
    }
    return fields;
}


async function applyConfig(params: ApplyClientConfigParams): Promise<ClientConfigStatus> {
    if (ormService.isWorker) {
        throw new Error("客户端管理需要读写本机配置文件，请本地安装后使用。");
    }

    const adapter = await getAdapter(params.client);
    const backup = await clientConfigManager.findByIdAndClient(params.backupId, params.client);

    if (!backup) {
        throw new Error("Backup not found");
    }

    const parsedBackup = extractFieldsFromBackup(backup.configContent, adapter);
    if (!parsedBackup) {
        throw new Error("无法解析保存的配置内容");
    }

    const currentContent = await adapter.readConfig();
    const patchedContent = adapter.patchConfigFileContent(currentContent, parsedBackup);

    await adapter.writeConfig(patchedContent);
    await enableBackup(params.client, backup);
    const adapterStatus = await configAdapterUtils.buildClientStatus(adapter);
    return await enrichStatus(adapterStatus, adapter);
}


export default {
    createBackup,
    createConfig,
    deleteBackup,
    getStatus,
    applyConfig,
    readLocalConfig,
    renameBackup,
    syncFromLocal,
    updateBackupConfig,
};

export type {
    ApplyClientConfigParams,
    ClientConfigBackupInfo,
    ClientConfigStatus,
    ClientConfigStatusResponse,
    DeleteClientConfigBackupParams,
    CreateClientConfigParams,
};
