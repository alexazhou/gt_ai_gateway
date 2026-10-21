/**
 * 协议无关的公共类型。
 */

/** 推理强度，OpenAI / Responses / Anthropic 的 thinking 配置都映射到该枚举 */
export enum ReasoningEffort {
    NONE = "none",
    MINIMAL = "minimal",
    LOW = "low",
    MEDIUM = "medium",
    HIGH = "high",
    XHIGH = "xhigh",
}

/** 一条 SSE 事件（协议无关的传输信封） */
export interface ProtocolStreamEvent {
    data: string;
    event?: string;
    id?: string;
}
