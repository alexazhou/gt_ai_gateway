// 规则 scope 表达式树与限流计数器的公共类型定义。
// 节点统一结构 { type, oper?, values }：type 为节点类型（叶子维度 / and / or / const），
// oper 仅叶子节点携带，values 为取值列表（叶子为比较值、and/or 为子节点列表、const 为 [true]）。

/** 叶子判断维度 */
export type ScopeField = "user_id" | "model_id" | "vendor_id";

/** 叶子运算符 */
export type ScopeOperator = "=" | "!=" | "in" | "not in";

/** 节点类型：叶子维度 + 组合（and / or）+ 恒真（const） */
export type ScopeNodeType = ScopeField | "and" | "or" | "const";

/** 叶子节点：type 为判断维度，oper 为运算符，values 为比较值列表（= / != 单元素，in / not in 非空） */
export interface LeafNode {
    type: ScopeField;
    oper: ScopeOperator;
    values: number[];
}

/** 组合节点：type 为 and / or，values 为子节点列表（必须非空） */
export interface LogicNode {
    type: "and" | "or";
    values: ExprNode[];
}

/** 恒真节点：type 为 const，values 固定为 [true]（全命中，全局兜底） */
export interface ConstNode {
    type: "const";
    values: [true];
}

export type ExprNode = LeafNode | LogicNode | ConstNode;

/** 请求上下文：vendor_id 仅在路由选择后可用 */
export interface RequestContext {
    user_id: number;
    model_id: number;
    vendor_id?: number;
}

/** 限流计数器存储接口：本期仅内存实现，接口预留以便后续切 DB / Durable Object */
export interface RateLimitStore {
    /** 自增 1 并返回加权计数（RPM：check + record 一步完成） */
    incr(key: string, now: number): number;
}
