import customError from "../../customError";
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
     * 上游流干净结束（EOF）时的收尾：返回需要补发给客户端的终止事件（无则空）。
     *
     * 只有「上游是 OpenAI chat completions」的转换器需要覆写：它的终止标记 [DONE] 是冗余的
     * （内容与 usage 在之前的事件里已到齐），部分兼容上游会省略它直接关闭连接，此时客户端仍缺
     * 本协议的终止事件。其余协议的终止事件承载信息（stop_reason / usage / 完整 response），
     * 缺失即为真截断，不在此补齐。
     *
     * 覆写时应以「上游是否已给出结束证据」为判据，并复用 handleDoneEvent()——它跑完会清空
     * 暂存状态，因此上游真发过 [DONE] 时这里天然返回空，不会重复补发。
     *
     * 由 responseHandlerService 在 EOF 分支调用（超时 / 上游断开 / 客户端断开等非干净结束不调用）。
     */
    public onUpstreamEnd(): ProtocolStreamEvent[] {
        return [];
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
