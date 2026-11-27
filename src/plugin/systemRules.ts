import { ConfigKey } from "../constants";

/**
 * 系统规则定义的**单一真源**（step2_technical.md §3.2）。
 *
 * 一条系统规则 = 一个高级设置开关的运行期形态：`biz_id` 把「规则」和「配置项」绑成一对，
 * 开关写入时按 `biz_id` 找到规则同步 `enabled`，请求期只从规则读、不再读配置。
 *
 * 为什么要有这份 TS 常量（#382 起它是**唯一真源**）：
 * - 迁移 `migrate_0035` 已经不再预置这四条（只做结构 + 存量配置搬迁），首次插入与后续纠偏
 *   都走运行期 `ensureSystemRules()`（`src/plugin/systemRulesSync.ts`），由启动路径调用；
 * - 测试清表（`dbHelper.truncate`）也调同一个 ensure 重建，不存在「第二份 SQL 要同步」；
 * - `tests/lifecycle/systemRulesStartup.node.test.ts` 用全新空库跑启动路径、逐字段比对这份常量，
 *   `tests/api/rule/systemRulesEnsure.test.ts` 钉住幂等 / 漂移纠正 / enabled 保护。
 */
export interface SystemPluginRuleDefinition {
    /** 系统规则业务标识（rule.biz_id），也是配置项与规则的绑定点 */
    bizId: string;
    /** 规则展示名 */
    name: string;
    /** 内置插件名（pluginRegistry 里注册的名字，T2 落地） */
    plugin: string;
    /** 执行优先级：数值越小越先执行，四条固定 10 / 20 / 30 / 40 */
    priority: number;
    /** 对应的高级设置配置项 */
    configKey: ConfigKey;
    /** 插件参数（系统规则一律空对象，参数只在用户规则里可配） */
    pluginConfig: Record<string, unknown>;
    /** 备注：说明来源与修改方式（rule.note，见 SYSTEM_RULE_NOTE） */
    note: string;
}

/**
 * 系统规则的备注：说明「这条规则哪来的、要改怎么改」，用户能在规则列表的备注框里看到。
 *
 * 唯一真源，运行期 ensure 写入；老库下次启动会因本字段与常量不一致被纠偏一次（updated=4）。
 */
export const SYSTEM_RULE_NOTE = "系统预置：由服务启动时自动生成，定义在 src/plugin/systemRules.ts。"
    + "规则本身只读（改名 / 优先级 / 参数都不要直接改表），启用状态请在「高级设置 → 请求处理」切换对应开关。";

export const SYSTEM_PLUGIN_RULES: readonly SystemPluginRuleDefinition[] = [
    {
        bizId: "SYS:setting:claudecode_tracking_rewrite",
        name: "屏蔽 Claude Code 跟踪",
        plugin: "claudeCodeTrackingRewriter",
        priority: 10,
        configKey: ConfigKey.CLAUDE_CODE_TRACKING_REWRITE_ENABLED,
        pluginConfig: {},
        note: SYSTEM_RULE_NOTE,
    },
    {
        bizId: "SYS:setting:cch_rewrite",
        name: "强制改写 CCH",
        plugin: "cchRewriter",
        priority: 20,
        configKey: ConfigKey.CCH_REWRITE_ENABLED,
        pluginConfig: {},
        note: SYSTEM_RULE_NOTE,
    },
    {
        bizId: "SYS:setting:responses_prompt_cache_key",
        name: "Responses API 粘性路由",
        plugin: "responsesPromptCacheKeyRewriter",
        priority: 30,
        configKey: ConfigKey.RESPONSES_PROMPT_CACHE_KEY_ENABLED,
        pluginConfig: {},
        note: SYSTEM_RULE_NOTE,
    },
    {
        bizId: "SYS:setting:session_header",
        name: "自动生成 session header",
        plugin: "addSessionHeader",
        priority: 40,
        configKey: ConfigKey.SESSION_HEADER_ENABLED,
        pluginConfig: {},
        note: SYSTEM_RULE_NOTE,
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
