import { SgConfig } from "../model/sgConfig";

const CCH_REWRITE_ENABLED = "cch_rewrite_enabled";
type ConfigMap = Record<string, string | boolean | number | null>;

function parseValue(value: string): string | boolean | number | null {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    const numberValue = Number(value);
    if (value.trim() !== "" && Number.isFinite(numberValue) && String(numberValue) === value) {
        return numberValue;
    }
    return value;
}

function stringifyValue(value: string | boolean | number | null): string {
    if (value === null) return "null";
    return String(value);
}

async function getValue(name: string, defaultValue: string): Promise<string> {
    const config = await SgConfig.query().where("name", name).first();
    return config?.value ?? defaultValue;
}

async function setValue(name: string, value: string): Promise<SgConfig> {
    const config = await SgConfig.query().where("name", name).first();
    if (config) {
        await config.update({ value });
        return config;
    }

    return await SgConfig.query().create({ name, value });
}

async function getBoolean(name: string, defaultValue: boolean): Promise<boolean> {
    const value = await getValue(name, defaultValue ? "true" : "false");
    return value === "true";
}

async function setBoolean(name: string, value: boolean): Promise<SgConfig> {
    return await setValue(name, value ? "true" : "false");
}

async function getAll(): Promise<ConfigMap> {
    const configs = await SgConfig.query().get();
    const result: ConfigMap = {};
    for (const config of configs) {
        result[config.name] = parseValue(config.value);
    }

    if (result[CCH_REWRITE_ENABLED] === undefined) {
        result[CCH_REWRITE_ENABLED] = false;
    }

    return result;
}

async function updateAll(data: ConfigMap): Promise<ConfigMap> {
    for (const [name, value] of Object.entries(data)) {
        await setValue(name, stringifyValue(value));
    }

    return await getAll();
}

async function isCchRewriteEnabled(): Promise<boolean> {
    return await getBoolean(CCH_REWRITE_ENABLED, false);
}

export default {
    getValue,
    setValue,
    getBoolean,
    setBoolean,
    getAll,
    updateAll,
    isCchRewriteEnabled,
};
