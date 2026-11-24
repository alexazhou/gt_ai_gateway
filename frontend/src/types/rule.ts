import type { BaseEntity, TableQuery } from './index';

export type RuleType = 'rate_limit' | 'forbid_access' | 'plugin';

/** 规则来源：system = 系统预置（只读，开关在高级设置），user = 用户自建 */
export type RuleSource = 'user' | 'system';

export type ScopeField = 'user_id' | 'model_id' | 'vendor_id';
export type ScopeOperator = '=' | '!=' | 'in' | 'not in';

/** 叶子节点：维度 + 运算符 + 比较值列表 */
export interface LeafNode {
    type: ScopeField;
    oper: ScopeOperator;
    values: number[];
}

/** 组合节点：and（全部满足）/ or（任一满足），values 必须非空 */
export interface LogicNode {
    type: 'and' | 'or';
    values: ExprNode[];
}

/** 固定值节点：values 为单个布尔值（true = 恒真/全部匹配，false = 恒假） */
export interface ConstNode {
    type: 'const';
    values: [boolean];
}

export type ExprNode = LeafNode | LogicNode | ConstNode;

/** rate_limit 的 config：rpm 为空表示不限制，0 表示不可用，N 为滑动窗口上限 */
export interface RateLimitConfig {
    rpm: number | null;
}

/** forbid_access 无 config（保留空对象） */
export interface AccessControlConfig {
    [key: string]: never;
}

/** plugin 的 config：插件名 + 插件参数（参数合法性由后端 / 插件自身校验） */
export interface PluginRuleConfig {
    plugin: string;
    pluginConfig: Record<string, unknown>;
}

export type RuleConfig = RateLimitConfig | AccessControlConfig | PluginRuleConfig;

/** 请求插件描述（GET /rule/plugins.json 的元素） */
export interface PluginDescriptor {
    name: string;
    description: string | null;
    hooks: string[];
    configExample: Record<string, unknown> | null;
}

export interface Rule extends BaseEntity {
    type: RuleType;
    name: string;
    scope: ExprNode;
    config: RuleConfig;
    enabled: boolean;
    /** 归属租户 id（非 main 视角列表可见 main 共享规则时，用于识别只读） */
    tenant_id?: number | null;
    /** 跨租户共享标记：1 = 所有租户生效（仅 main 租户规则可置 1） */
    cross_tenant?: boolean;
    /** 优先级：数值越小越先执行（0~10000，默认 100） */
    priority: number;
    /** 规则来源：system 为系统预置，不可编辑 / 删除 */
    source: RuleSource;
    /** 系统规则的稳定业务标识（如 SYS:setting:cch_rewrite），用户规则为 null */
    biz_id?: string | null;
}

export interface RuleQuery extends TableQuery {
    keyword?: string;
    /** 按来源过滤；不传 = 后端默认只返回用户规则 */
    source?: RuleSource;
}

export interface CreateRuleRequest {
    type: RuleType;
    name: string;
    scope: ExprNode;
    config: RuleConfig;
    enabled: boolean;
    cross_tenant?: boolean;
    priority?: number;
}

export type UpdateRuleRequest = Partial<CreateRuleRequest>;

/** 条件树叶子下拉选项：id 为条件比较值，name 用于展示 */
export interface ScopeOption {
    id: number;
    name: string;
}

/** 三个叶子维度（用户 / 模型 / 供应商）的下拉选项集 */
export interface ScopeOptions {
    models: ScopeOption[];
    users: ScopeOption[];
    vendors: ScopeOption[];
}
