import type { ClientConfigContent, ClientConfigFields, FileSystemApi, PathApi } from "./types";
import BaseConfigAdapter from "./baseConfigAdapter";
import configAdapterUtils from "./configAdapterUtils";
import { ClientName } from "../../constants";


class ClaudeCodeConfigAdapter extends BaseConfigAdapter {
    readonly defaultGatewaySuffix = "/llm";

    constructor(fs: FileSystemApi, path: PathApi, homeDir: string) {
        super(fs, path, ClientName.CLAUDE_CODE, "Claude Code", path.join(homeDir, ".claude", "settings.json"));
    }

    private buildBaseUrl(fields: ClientConfigFields): string {
        const url = fields.gatewayUrl.replace(/\/+$/, "");
        if ((fields.connectionMode || "gateway") === "vendor") {
            return url
                .replace(/\/v1\/messages\/?$/, "")
                .replace(/\/v1\/?$/, "");
        }
        if (url.endsWith(this.defaultGatewaySuffix)) {
            return url;
        }
        return `${url}${this.defaultGatewaySuffix}`;
    }

    parseConfigContent(configContent: ClientConfigContent): ClientConfigFields | null {
        const content = configContent[this.configPath] || "";
        if (!content) {
            return null;
        }

        const config = configAdapterUtils.parseJsonConfig(content);
        const backendUrl = config.env?.ANTHROPIC_BASE_URL || "";
        const token = config.env?.ANTHROPIC_AUTH_TOKEN || config.env?.ANTHROPIC_API_KEY || "";
        if (!backendUrl || !token) {
            return null;
        }

        return {
            connectionMode: this.isGatewayUrl(config.env?.ANTHROPIC_BASE_URL) ? "gateway" : "vendor", // Accurate deduction by host and port
            gatewayUrl: backendUrl,
            apiKey: token,
            model: config.env?.ANTHROPIC_MODEL || config.env?.CLAUDE_CODE_SUBAGENT_MODEL || config.model || "",
            protocol: "anthropic",
            effortLevel: config.env?.CLAUDE_CODE_EFFORT_LEVEL || "",
        };
    }

    patchConfigContent(content: ClientConfigContent, fields: ClientConfigFields): ClientConfigContent {
        const oldContent = content[this.configPath] || "";
        const config = configAdapterUtils.parseJsonConfig(oldContent);
        config.env = {
            ...(config.env || {}),
            ANTHROPIC_BASE_URL: this.buildBaseUrl(fields),
            ANTHROPIC_AUTH_TOKEN: fields.apiKey,
        };
        
        // Remove old deprecated configs
        delete config.model;
        delete config.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;

        if (fields.model.trim()) {
            const model = fields.model.trim();
            config.env.ANTHROPIC_MODEL = model;
            config.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
            config.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
            config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
            config.env.CLAUDE_CODE_SUBAGENT_MODEL = model;
        }

        if (fields.effortLevel?.trim()) {
            config.env.CLAUDE_CODE_EFFORT_LEVEL = fields.effortLevel.trim();
        }

        return {
            [this.configPath]: `${JSON.stringify(config, null, 4)}\n`,
        };
    }
}


export default ClaudeCodeConfigAdapter;
