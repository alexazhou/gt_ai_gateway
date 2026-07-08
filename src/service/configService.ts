import { SgConfig } from "../model/sgConfig";

export enum ConfigKey {
    CCH_REWRITE_ENABLED = "cch_rewrite_enabled",
    RESPONSES_PROMPT_CACHE_KEY_ENABLED = "responses_prompt_cache_key_enabled",
    CLAUDE_CODE_TRACKING_REWRITE_ENABLED = "claudecode_tracking_rewrite_enabled",
    HOST_KEY = "host_key",
    STREAM_LOG_ENABLED = "stream_log_enabled",
    AUTO_UPDATE_ENABLED = "auto_update_enabled",
    TELEMETRY_DISABLED = "telemetry_disabled",
    RECORD_PAYLOAD_ENABLED = "record_payload_enabled",
}

// 各配置项的默认值集中在此维护，调用方无需再传默认值。
// 未在表中登记的 key 默认值为空字符串。
const CONFIG_DEFAULTS: Record<string, string> = {
    [ConfigKey.CCH_REWRITE_ENABLED]: "true",
    [ConfigKey.RESPONSES_PROMPT_CACHE_KEY_ENABLED]: "true",
    [ConfigKey.CLAUDE_CODE_TRACKING_REWRITE_ENABLED]: "true",
    [ConfigKey.HOST_KEY]: "",
    [ConfigKey.STREAM_LOG_ENABLED]: "false",
    [ConfigKey.AUTO_UPDATE_ENABLED]: "true",
    [ConfigKey.TELEMETRY_DISABLED]: "false",
    [ConfigKey.RECORD_PAYLOAD_ENABLED]: "true",
};

function getDefault(name: string): string {
    return CONFIG_DEFAULTS[name] ?? "";
}

export class ConfigItem {
    constructor(private readonly value: string | null | undefined, private readonly defaultValue: string) {}

    getString(): string {
        return this.value ?? this.defaultValue;
    }

    getBoolean(): boolean {
        const val = this.value ?? this.defaultValue;
        if (val === "true") return true;
        if (val === "false") return false;
        return false;
    }

    getNumber(): number {
        const val = this.value ?? this.defaultValue;
        if (!val || val.trim() === "") return 0;
        const num = Number(val);
        return Number.isFinite(num) ? num : 0;
    }
}

const cache = new Map<string, string | null>();
let isAllLoaded = false;

async function getConfig(name: ConfigKey | string): Promise<ConfigItem> {
    const key = name as string;
    const defaultValue = getDefault(key);

    if (cache.has(key)) {
        return new ConfigItem(cache.get(key), defaultValue);
    }

    const config = await SgConfig.query().where("name", key).first();
    if (config) {
        cache.set(key, config.value);
        return new ConfigItem(config.value, defaultValue);
    }

    cache.set(key, null);
    return new ConfigItem(undefined, defaultValue);
}

async function setValue(name: ConfigKey | string, value: string): Promise<SgConfig> {
    const key = name as string;
    const strValue = String(value);
    const config = await SgConfig.query().where("name", key).first();
    
    let result: SgConfig;
    if (config) {
        await config.update({ value: strValue });
        result = config;
    } else {
        result = await SgConfig.query().create({ name: key, value: strValue });
    }
    
    cache.set(key, strValue);
    return result;
}

async function getAll(): Promise<Record<string, string>> {
    if (!isAllLoaded) {
        const configs = await SgConfig.query().get();
        for (const config of configs) {
            cache.set(config.name, config.value);
        }
        isAllLoaded = true;
    }
    
    const result: Record<string, string> = { ...CONFIG_DEFAULTS };
    for (const [key, value] of cache.entries()) {
        if (value !== null) {
            result[key] = value;
        }
    }
    return result;
}

async function updateAll(data: Record<string, string>): Promise<Record<string, string>> {
    for (const [name, value] of Object.entries(data)) {
        await setValue(name, value);
    }

    return await getAll();
}

function clearCache() {
    cache.clear();
    isAllLoaded = false;
}

export default {
    getConfig,
    setValue,
    getAll,
    updateAll,
    clearCache,
};
