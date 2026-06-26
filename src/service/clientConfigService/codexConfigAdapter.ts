import type { ClientConfigStatus, CreateClientConfigParams, CurrentClientConfig, FileSystemApi, PathApi } from "./types";
import BaseConfigAdapter from "./baseConfigAdapter";
import configAdapterUtils from "./configAdapterUtils";
import tomlUtil from "../../util/tomlUtil";
import { ClientName } from "../../constants";


class CodexConfigAdapter extends BaseConfigAdapter {
    constructor(fs: FileSystemApi, path: PathApi, homeDir: string) {
        const codexHome = process.env.CODEX_HOME || path.join(homeDir, ".codex");
        super(fs, path, ClientName.CODEX, "Codex", path.join(codexHome, "config.toml"), [
            path.join(codexHome, "config.toml"),
            path.join(codexHome, "auth.json"),
        ]);
    }

    private buildBaseUrl(params: CreateClientConfigParams): string {
        const url = params.gatewayUrl.replace(/\/+$/, "");
        if ((params.connectionMode || "gateway") === "vendor") {
            return url
                .replace(/\/responses\/?$/, "")
                .replace(/\/chat\/completions\/?$/, "");
        }
        return params.gatewayUrl;
    }


    async parseConfigContent(configContent: Record<string, string>): Promise<CurrentClientConfig | null> {
        const content = configContent[this.configPath] || "";
        if (!content) {
            return null;
        }

        const provider = tomlUtil.getTomlValue(content, "model_provider") || "";
        const providerTable = provider ? `model_providers.${provider}` : "";
        const backendUrl = providerTable ? tomlUtil.getTomlTableValue(content, providerTable, "base_url") || "" : "";
        const token = providerTable ? tomlUtil.getTomlTableValue(content, providerTable, "experimental_bearer_token") || "" : "";
        if (!provider || !backendUrl || !token) {
            return null;
        }

        const gatewayUser = await configAdapterUtils.findGatewayUserByToken(token);
        return {
            configPath: this.configPath,
            connectionMode: gatewayUser ? "gateway" : "vendor",
            backendUrl,
            token,
            model: tomlUtil.getTomlValue(content, "model") || "",
            protocol: "responses",
            gatewayUser,
        };
    }


    async getStatus(): Promise<ClientConfigStatus> {
        const installed = await this.isInstalled();
        let configured = false;
        let message: string | undefined;
        let currentConfig: CurrentClientConfig | null = null;

        if (installed && await configAdapterUtils.pathExists(this.fs, this.configPath)) {
            try {
                currentConfig = await this.parseConfigContent({ [this.configPath]: await this.readConfigFile() });
                configured = Boolean(currentConfig);
            } catch (error) {
                message = `配置文件读取失败: ${String(error)}`;
            }
        }

        return {
            client: this.client,
            displayName: this.displayName,
            installed,
            configured,
            backupExists: false,
            backupCount: 0,
            backups: [],
            activeConfigModified: false,
            currentConfig,
            configPath: this.configPath,
            configPaths: this.configPaths,
            message,
        };
    }


    async buildConfigContent(params: CreateClientConfigParams): Promise<Record<string, string>> {
        if (!(await this.isInstalled())) {
            throw new Error("Codex config directory not found");
        }

        let content = await this.readConfigFile();
        content = tomlUtil.upsertRootTomlValue(content, "model_provider", tomlUtil.buildTomlString("gt_ai_gateway"));

        if (params.model.trim()) {
            content = tomlUtil.upsertRootTomlValue(content, "model", tomlUtil.buildTomlString(params.model.trim()));
        }

        content = tomlUtil.upsertTomlTable(content, "model_providers.gt_ai_gateway", {
            name: tomlUtil.buildTomlString("GT AI Gateway"),
            base_url: tomlUtil.buildTomlString(this.buildBaseUrl(params)),
            wire_api: tomlUtil.buildTomlString("responses"),
            experimental_bearer_token: tomlUtil.buildTomlString(params.apiKey),
        });

        return {
            [this.configPath]: `${content.trim()}\n`,
        };
    }
}


export default CodexConfigAdapter;
