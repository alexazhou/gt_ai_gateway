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

/** 固定值节点：type 为 const，values 为单个布尔值（true = 恒真全命中，false = 恒假） */
export interface ConstNode {
    type: "const";
    values: [boolean];
}

export type ExprNode = LeafNode | LogicNode | ConstNode;

/** 请求上下文：vendor_id 仅在路由选择后可用 */
export interface RequestContext {
    user_id: number;
    model_id: number;
    vendor_id?: number;
}

/** 令牌桶消费结果 */
export interface ConsumeResult {
    /** 是否获得令牌（放行）；false = 桶空被限流 */
    allowed: boolean;
    /** allowed=true：扣减后的剩余令牌数；allowed=false：此刻桶内令牌数（< 1，用于计算等待时间） */
    remaining: number;
}

/** 限流计数器存储接口：本期仅内存实现（令牌桶），接口预留以便后续切 DB / Durable Object */
export interface RateLimitStore {
    /**
     * 令牌桶消费：按 refillPerMs 补液（封顶 capacity），再尝试扣 1 个令牌。
     * @param capacity 桶容量（瞬时突发上限，即 rpm）
     * @param refillPerMs 补液速率（令牌/毫秒 = rpm / 60s）
     */
    consume(key: string, now: number, capacity: number, refillPerMs: number): ConsumeResult;
}
