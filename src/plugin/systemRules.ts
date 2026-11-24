import { ConfigKey } from "../constants";

/**
 * 系统规则定义的**单一真源**（step2_technical.md §3.2）。
 *
 * 一条系统规则 = 一个高级设置开关的运行期形态：`biz_id` 把「规则」和「配置项」绑成一对，
 * 开关写入时按 `biz_id` 找到规则同步 `enabled`，请求期只从规则读、不再读配置。
 *
 * 为什么要有这份 TS 常量而不是只写 SQL：
 * - `migrate_0035` 只能在 SQL 里再写一遍同样的三条（迁移文件不能 import TS）；
 * - 测试清表（`dbHelper.truncate`）会把 rule 表清空但要保留这三条，只能靠 TS 侧重建；
 * - 两处必然要各写一遍，所以用 `tests/lifecycle/genericPluginMigration.node.test.ts` 把
 *   「迁移产出的行」与「这份常量」逐字段比对，**让漂移变成会红的测试**。
 */
export interface SystemPluginRuleDefinition {
    /** 系统规则业务标识（rule.biz_id），也是配置项与规则的绑定点 */
    bizId: string;
    /** 规则展示名 */
    name: string;
    /** 内置插件名（pluginRegistry 里注册的名字，T2 落地） */
    plugin: string;
    /** 执行优先级：数值越小越先执行，三条固定 10 / 20 / 30 */
    priority: number;
    /** 对应的高级设置配置项 */
    configKey: ConfigKey;
    /** 插件参数（系统规则一律空对象，参数只在用户规则里可配） */
    pluginConfig: Record<string, unknown>;
}

export const SYSTEM_PLUGIN_RULES: readonly SystemPluginRuleDefinition[] = [
    {
        bizId: "SYS:setting:claudecode_tracking_rewrite",
        name: "屏蔽 Claude Code 跟踪",
        plugin: "claudeCodeTrackingRewriter",
        priority: 10,
        configKey: ConfigKey.CLAUDE_CODE_TRACKING_REWRITE_ENABLED,
        pluginConfig: {},
    },
    {
        bizId: "SYS:setting:cch_rewrite",
        name: "强制改写 CCH",
        plugin: "cchRewriter",
        priority: 20,
        configKey: ConfigKey.CCH_REWRITE_ENABLED,
        pluginConfig: {},
    },
    {
        bizId: "SYS:setting:responses_prompt_cache_key",
        name: "Responses API 粘性路由",
        plugin: "responsesPromptCacheKeyRewriter",
        priority: 30,
        configKey: ConfigKey.RESPONSES_PROMPT_CACHE_KEY_ENABLED,
        pluginConfig: {},
    },
];

/** 系统规则与用户规则的来源标记（rule.source） */
export const RULE_SOURCE = {
    SYSTEM: "system",
    USER: "user",
} as const;

export type RuleSource = (typeof RULE_SOURCE)[keyof typeof RULE_SOURCE];

/**
 * 旧前端遗留的配置键名 → 新键名（migrate_0035 已搬过数据，写入侧仍需兼容：
 * 老前端页面未升级时仍会提交旧键名）。
 */
export const LEGACY_CONFIG_KEY_ALIASES: Readonly<Record<string, ConfigKey>> = {
    claude_code_tracking_rewrite_enabled: ConfigKey.CLAUDE_CODE_TRACKING_REWRITE_ENABLED,
};

/** 按配置键找系统规则定义（不存在返回 null） */
export function findSystemRuleByConfigKey(configKey: ConfigKey | string): SystemPluginRuleDefinition | null {
    return SYSTEM_PLUGIN_RULES.find((rule) => rule.configKey === configKey) ?? null;
}

/** 按 biz_id 找系统规则定义（不存在返回 null） */
export function findSystemRuleByBizId(bizId: string): SystemPluginRuleDefinition | null {
    return SYSTEM_PLUGIN_RULES.find((rule) => rule.bizId === bizId) ?? null;
}

/** 规则 `config` 列里 plugin 类型的结构（step2_technical.md §3.1） */
export interface PluginRuleConfig {
    plugin: string;
    pluginConfig: Record<string, unknown>;
}
