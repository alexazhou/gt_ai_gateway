import type { BaseEntity, TableQuery } from './index';

export type RuleType = 'rate_limit' | 'access_control';

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

/** 恒真节点：全部匹配，values 固定为 [true] */
export interface ConstNode {
    type: 'const';
    values: [true];
}

export type ExprNode = LeafNode | LogicNode | ConstNode;

/** rate_limit 的 config：rpm 为空表示不限制，0 表示不可用，N 为滑动窗口上限 */
export interface RateLimitConfig {
    rpm: number | null;
}

/** access_control 无 config（保留空对象） */
export interface AccessControlConfig {
    [key: string]: never;
}

export type RuleConfig = RateLimitConfig | AccessControlConfig;

export interface Rule extends BaseEntity {
    type: RuleType;
    name: string;
    scope: ExprNode;
    config: RuleConfig;
    enabled: boolean;
}

export interface RuleQuery extends TableQuery {
    keyword?: string;
}

export interface CreateRuleRequest {
    type: RuleType;
    name: string;
    scope: ExprNode;
    config: RuleConfig;
    enabled: boolean;
}

export type UpdateRuleRequest = Partial<CreateRuleRequest>;
