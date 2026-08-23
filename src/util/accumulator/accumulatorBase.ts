import type { ProtocolStreamEvent } from "../protocolConverter/protocolTypes";


/**
 * 流式响应累加器基类
 * 封装三个协议累加器共用的流状态：完成、错误、首个输出，以及错误 payload。
 * 子类负责协议相关的解析与累积，通过 protected 方法上报状态，并实现 addEvent / getResponse / getUsage。
 */

export abstract class AccumulatorBase {
    protected completed = false;
    protected errored = false;
    protected error: object | null = null;
    protected parseFailed = false;
    protected outputStarted = false;

    /**
     * 接收一条客户端 SSE 事件（协议的累积实现，子类必须实现）
     */
    abstract addEvent(clientEvent: ProtocolStreamEvent): void;

    /**
     * 获取累积的完整响应对象（子类返回各自协议形态）
     */
    abstract getResponse(): unknown;

    /**
     * 获取累积的 usage；上游未返回时为 null（子类实现）
     */
    abstract getUsage(): unknown | null;

    /**
     * 标记流已完整接收（子类在识别到结束事件时调用）
     */
    protected markCompleted(): void {
        this.completed = true;
    }

    /**
     * 标记收到错误事件并保存 payload（子类在识别到错误事件时调用）
     */
    protected markError(payload: object): void {
        this.errored = true;
        this.error = payload;
    }

    /**
     * 标记解析上游内容失败（data 无法解析为合法 JSON）；解析失败也算上游内容错误，
     * 因此同时置 errored（与 markError 的区别仅是这不携带错误 payload）
     */
    protected markParseFailed(): void {
        this.errored = true;
        this.parseFailed = true;
    }

    /**
     * 标记模型已开始产出内容（子类在识别到首个输出事件时调用）
     */
    protected markOutputStarted(): void {
        this.outputStarted = true;
    }

    /**
     * 是否收到流结束标记
     */
    isCompleted(): boolean {
        return this.completed;
    }

    /**
     * 是否收到错误事件
     */
    isErrored(): boolean {
        return this.errored;
    }

    /**
     * 是否解析上游内容失败（data 不是合法 JSON）
     */
    isParseFailed(): boolean {
        return this.parseFailed;
    }

    /**
     * 模型是否已开始产出内容（用于测量首 token 时间 TTFT）
     */
    isOutputStarted(): boolean {
        return this.outputStarted;
    }

    /**
     * 获取流式错误 payload
     */
    getError(): object | null {
        return this.error;
    }

    /**
     * 重置流状态（子类应在自己的 reset() 中调用并重置协议相关数据）
     */
    protected resetState(): void {
        this.completed = false;
        this.errored = false;
        this.error = null;
        this.parseFailed = false;
        this.outputStarted = false;
    }
}

export default AccumulatorBase;
