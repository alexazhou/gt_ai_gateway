import customError from "../customErrorUtil";
import type { ProtocolStreamEvent } from "./protocolTypes";

export abstract class BaseConverter {
    protected requestModel: string;
    protected responseId: string;
    protected contentBlockIndex = 0;

    constructor(requestModel: string = "unknown", responseId?: string) {
        this.requestModel = requestModel;
        this.responseId = responseId || `chatcmpl-${Date.now()}`;
    }

    /**
     * 将请求体字符串转换为上游所需格式的字符串
     */
    public convertRequestBody(bodyStr: string): string {
        let bodyJson: any;
        try {
            bodyJson = JSON.parse(bodyStr);
        } catch (e) {
            throw new customError.AppError(
                `Failed to parse request body for protocol conversion: invalid JSON`,
                400,
            );
        }

        try {
            const converted = this.convertRequest(bodyJson);
            return JSON.stringify(converted);
        } catch (e) {
            if (e instanceof customError.AppError) throw e;
            throw new customError.AppError(
                `Protocol conversion failed: ${e instanceof Error ? e.message : String(e)}`,
                400,
            );
        }
    }

    /**
     * 更新请求模型名称（常用于提取请求体后或第一条流式响应到来时）
     */
    public updateModel(model: string) {
        this.requestModel = model;
    }

    /**
     * 更新响应 ID
     */
    public updateResponseId(id: string) {
        this.responseId = id;
    }

    /**
     * 将客户端请求转换为上游请求格式
     */
    public abstract convertRequest(clientReq: any): any;

    /**
     * 将上游非流式响应转换为客户端非流式响应格式
     */
    public abstract convertResponse(upstreamRes: any, requestId?: string): any;

    /**
     * 将上游流式事件转换为客户端流式事件列表
     * 内部实现了针对 [DONE] 的处理模板，具体数据转换由 doConvertStreamEvent 负责
     */
    public convertStreamEvent(dataStr: string, event?: string, id?: string): ProtocolStreamEvent[] {
        // 全局处理 [DONE] 事件
        if (dataStr === "[DONE]") {
            return this.handleDoneEvent();
        }

        let data: Record<string, unknown>;
        try {
            data = JSON.parse(dataStr);
        } catch {
            return [{ data: dataStr, event, id }]; // 解析失败，透传
        }

        return this.doConvertStreamEvent(data, dataStr);
    }

    /**
     * 处理 [DONE] 事件
     * 默认返回空事件列表（在外部组装时跳过）
     * 子类可以根据需要重写此方法（例如 OpenAI -> Anthropic 可能需要补发 stop 事件）
     */
    protected handleDoneEvent(): ProtocolStreamEvent[] {
        return [];
    }

    /**
     * 将上游流式事件数据对象转换为客户端事件列表
     */
    protected abstract doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[];
}
