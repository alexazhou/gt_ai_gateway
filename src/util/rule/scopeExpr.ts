import customError from "../../customError";
import type { ExprNode, LeafNode, LogicNode, RequestContext, ScopeField, ScopeOperator, ScopeNodeType } from "./types";

// 合法节点类型集合（叶子维度 + and / or / const）
const SCOPE_FIELDS: ScopeField[] = ["user_id", "model_id", "vendor_id"];
const SCOPE_OPERATORS: ScopeOperator[] = ["=", "!=", "in", "not in"];
const SCOPE_NODE_TYPES: ScopeNodeType[] = [...SCOPE_FIELDS, "and", "or", "const"];
// 表达式树深度上限（防滥用），0 为根节点深度
const MAX_SCOPE_DEPTH = 8;


/** 叶子条件匹配：所有维度统一标量比较 */
function matchCondition(actual: number, node: LeafNode): boolean {
    switch (node.oper) {
        case "=":      return actual === node.values[0];
        case "!=":     return actual !== node.values[0];
        case "in":     return node.values.includes(actual);
        case "not in": return !node.values.includes(actual);
        default:       return false;
    }
}


/** 表达式树求值：and 全真、or 任一真、const 返回固定布尔值、叶子按维度取值匹配 */
function evalExpr(node: ExprNode, ctx: RequestContext): boolean {
    switch (node.type) {
        case "and":   return node.values.every(child => evalExpr(child, ctx));
        case "or":    return node.values.some(child => evalExpr(child, ctx));
        case "const": return node.values[0];
        default:      return matchCondition(ctx[node.type] as number, node);
    }
}


/** 判断表达式树是否引用 vendor_id（用于分流阶段一 / 阶段二） */
function exprReferencesVendor(node: ExprNode): boolean {
    if (node.type === "and" || node.type === "or") {
        return node.values.some(exprReferencesVendor);
    }
    return node.type === "vendor_id";
}


/** 校验 scope 为合法表达式树；不合法时抛 AppError（带明确原因） */
function validateScope(node: unknown, depth: number = 0): void {
    if (depth > MAX_SCOPE_DEPTH) {
        throw new customError.AppError(`Scope tree depth exceeds limit of ${MAX_SCOPE_DEPTH}`);
    }

    if (node === null || typeof node !== "object" || Array.isArray(node)) {
        throw new customError.AppError("Scope must be an object");
    }
    const candidate = node as Record<string, unknown>;

    const nodeType = candidate.type as ScopeNodeType;
    if (!SCOPE_NODE_TYPES.includes(nodeType)) {
        throw new customError.AppError(`Invalid scope node type: ${String(candidate.type)}`);
    }

    if (nodeType === "and" || nodeType === "or") {
        const values = candidate.values;
        if (!Array.isArray(values) || values.length === 0) {
            throw new customError.AppError(`Scope "${nodeType}" node requires a non-empty values array`);
        }
        for (const child of values) {
            validateScope(child, depth + 1);
        }
        return;
    }

    if (nodeType === "const") {
        const values = candidate.values;
        if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "boolean") {
            throw new customError.AppError('Scope "const" node must have values = [true] or [false]');
        }
        return;
    }

    // 叶子节点
    const leaf = candidate as Partial<LeafNode>;
    if (!SCOPE_OPERATORS.includes(leaf.oper as ScopeOperator)) {
        throw new customError.AppError(`Invalid scope operator: ${String(leaf.oper)}`);
    }
    if (!Array.isArray(leaf.values)) {
        throw new customError.AppError("Scope leaf values must be an array");
    }
    for (const value of leaf.values) {
        if (typeof value !== "number" || !Number.isInteger(value)) {
            throw new customError.AppError("Scope leaf values must be integers");
        }
    }
    if (leaf.oper === "=" || leaf.oper === "!=") {
        if (leaf.values.length !== 1) {
            throw new customError.AppError(`Scope operator "${leaf.oper}" requires exactly one value`);
        }
    } else if (leaf.values.length === 0) {
        throw new customError.AppError(`Scope operator "${leaf.oper}" requires a non-empty values array`);
    }
}


export default {
    matchCondition,
    evalExpr,
    exprReferencesVendor,
    validateScope,
};
