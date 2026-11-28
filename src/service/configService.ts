import { SgConfig } from "../model/sgConfig";
import { ConfigKey } from "../constants";
import configManager from "../manager/configManager";
import ruleManager from "../manager/ruleManager";
import customError from "../customError";
import { findSystemRuleByConfigKey, LEGACY_CONFIG_KEY_ALIASES } from "../plugin/systemRules";

// 各配置项的默认值集中在此维护，调用方无需再传默认值。
// 未在表中登记的 key 默认值为空字符串。
const CONFIG_DEFAULTS: Record<string, string> = {
    [ConfigKey.CCH_REWRITE_ENABLED]: "true",
    [ConfigKey.RESPONSES_PROMPT_CACHE_KEY_ENABLED]: "true",
    [ConfigKey.CLAUDE_CODE_TRACKING_REWRITE_ENABLED]: "true",
    // 默认关闭：开启后每个请求的上游头都会多一个会话标识，属于改变上游可见行为的开关
    [ConfigKey.SESSION_HEADER_ENABLED]: "false",
    [ConfigKey.HOST_KEY]: "",
    [ConfigKey.STREAM_LOG_ENABLED]: "false",
    [ConfigKey.AUTO_UPDATE_ENABLED]: "true",
    [ConfigKey.TELEMETRY_DISABLED]: "false",
    [ConfigKey.RECORD_PAYLOAD_ENABLED]: "true",
    [ConfigKey.RECORD_PAYLOAD_STORAGE]: "auto",
    [ConfigKey.MODULE_BILLING_ENABLED]: "true",
    [ConfigKey.MODULE_API_PLAYGROUND_ENABLED]: "true",
    [ConfigKey.MODULE_CLIENT_CONFIG_ENABLED]: "true",
    [ConfigKey.UPSTREAM_HEADERS_TIMEOUT_MS]: "900000",
    [ConfigKey.UPSTREAM_NON_STREAM_TIMEOUT_MS]: "180000",
    [ConfigKey.UPSTREAM_STREAM_IDLE_TIMEOUT_MS]: "180000",
    // 流式响应总时长上限（P2-23 兜底）：0 = 不限
    [ConfigKey.STREAM_MAX_DURATION_MS]: "1800000",
    // 流式读缓冲上限（P1-05）：8MB，0 = 不限
    [ConfigKey.SSE_MAX_BUFFER_BYTES]: "8388608",
    [ConfigKey.ORPHAN_RECOVER_THRESHOLD_MS]: "600000",
    // 多租户隔离默认关闭（存量单租户部署迁移后行为与迁移前一致）
    [ConfigKey.MULTI_TENANT_ENABLED]: "false",
    // LLM 请求体上限（P2-03）：32MB，0 = 不限
    [ConfigKey.LLM_MAX_BODY_BYTES]: "33554432",
};

/** 多租户隔离是否开启（false = 逻辑单租户，所有请求固定 main） */
async function isMultiTenantEnabled(): Promise<boolean> {
    return (await getConfig(ConfigKey.MULTI_TENANT_ENABLED)).getBoolean();
}

function getDefault(name: string): string {
    return CONFIG_DEFAULTS[name] ?? "";
}

/**
 * 读取某配置项的**后端默认值**（未落库时的取值）。
 *
 * 单独导出是为了让不经过 configService 的调用方（测试 helper 用裸 SQL 建库、迁移脚本旁路校验）
 * 也能拿到同一份默认值，避免"默认值"被复制成第二份。
 */
function getConfigDefault(name: ConfigKey | string): string {
    return getDefault(name as string);
}

/**
 * 旧前端提交的配置键 → 当前键名。
 *
 * 前端升级不同步：老页面仍会提交 `claude_code_tracking_rewrite_enabled`，
 * 迁移已经把数据搬到新键，写入侧再做一次归一，避免"老页面存了但新键没变"。
 */
function normalizeConfigKey(name: ConfigKey | string): string {
    const key = name as string;
    return LEGACY_CONFIG_KEY_ALIASES[key] ?? key;
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
    const key = normalizeConfigKey(name);
    const defaultValue = getDefault(key);

    if (cache.has(key)) {
        return new ConfigItem(cache.get(key), defaultValue);
    }

    const config = await configManager.get(key);
    if (config) {
        cache.set(key, config.value);
        return new ConfigItem(config.value, defaultValue);
    }

    cache.set(key, null);
    return new ConfigItem(undefined, defaultValue);
}

// 便捷读取：直接拿数值（未配置/非法值为 0），免去 getConfig(...).getNumber() 两步
async function getNumber(name: ConfigKey | string): Promise<number> {
    return (await getConfig(name)).getNumber();
}

// 全局计费总开关：module_billing_enabled 为 false 时，后端不预检余额、不扣费
async function isModuleBillingEnabled(): Promise<boolean> {
    return (await getConfig(ConfigKey.MODULE_BILLING_ENABLED)).getBoolean();
}

/**
 * 写配置（高级设置页 / hostService 等共用）。
 *
 * 「高级设置 → 请求处理」的三个开关是系统规则的**唯一写入口**：写入时按 `biz_id` 同步规则的
 * `enabled`，并借 `ruleManager` 的失效回调清掉规则缓存 ⇒ 当前实例立即生效（多实例靠 60s TTL 兜底）。
 *
 * 缺规则时**报错 + 日志，不自动补齐**：自动创建会把"迁移没跑 / 被清表"掩盖成"一切正常"，
 * 而请求期只读规则 ⇒ 开关点了没反应且没人知道。所以先查规则存在性，再写配置（避免半写状态）。
 */
async function setValue(name: ConfigKey | string, value: string): Promise<SgConfig> {
    const key = normalizeConfigKey(name);
    const strValue = String(value);

    const systemRule = findSystemRuleByConfigKey(key);
    const nextEnabled = new ConfigItem(strValue, getDefault(key)).getBoolean();
    if (systemRule) {
        await assertSystemRuleExists(systemRule.bizId, key);
    }

    const result = await configManager.set(key, strValue);
    cache.set(key, strValue);

    if (systemRule) {
        const synced = await ruleManager.setSystemRuleEnabled(systemRule.bizId, nextEnabled);
        if (!synced) {
            // 检查与写入之间规则被删（并发/手工改库）：配置已落库，这里只能留痕并让缓存失效，
            // 不能假装同步成功，也不回滚配置（回滚会让用户以为开关没保存）
            console.error(
                `[configService] System rule "${systemRule.bizId}" disappeared while syncing "${key}"; `
                + `config saved but rule state is NOT synced`,
            );
        }
    }

    return result;
}


/** 系统规则必须已存在（迁移预置）；缺了就抛错，不自动创建 */
async function assertSystemRuleExists(bizId: string, configKey: string): Promise<void> {
    const rule = await ruleManager.findByBizId(bizId);
    if (!rule) {
        const message = `System rule "${bizId}" is missing, so changing "${configKey}" would have no effect`;
        console.error(`[configService] ${message}`);
        throw new customError.AppError(message, 500);
    }
}

async function getAll(): Promise<Record<string, string>> {
    if (!isAllLoaded) {
        const configs = await configManager.getAll();
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
    // 先整体预检系统规则是否存在：任一缺失就整份拒绝，避免"写了一半配置才发现规则没了"
    for (const [name] of Object.entries(data)) {
        const key = normalizeConfigKey(name);
        const systemRule = findSystemRuleByConfigKey(key);
        if (systemRule) {
            await assertSystemRuleExists(systemRule.bizId, key);
        }
    }

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
    getConfigDefault,
    getNumber,
    setValue,
    getAll,
    updateAll,
    clearCache,
    isModuleBillingEnabled,
    isMultiTenantEnabled,
};
