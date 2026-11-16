import customError from "../../customError";
import { FailedCode } from "../../constants";
import type { ProtocolStreamEvent } from "../protocol/commonTypes";

/**
 * 记录里 `stop_reason` 的来源（供 request_activity 的 result 阶段标注，不影响客户端输出）：
 * - `"upstream"`：上游确实给了 finish_reason，值来自上游（可能经转换器的映射表换算）；
 * - `"synthesized"`：上游没给 finish_reason，stop_reason 由我方兜底生成。
 *
 * 只表达「有没有被我方兜底」，不表达取值的语义是否完美——映射表对未知取值的默认值
 * 仍记 `"upstream"`（因为上游确实给了收尾信号）。
 */
export type StopReasonSource = "upstream" | "synthesized";

export abstract class BaseConverter {
    protected requestModel: string;
    /** 构造时传入的模型名（不会被上游事件覆盖），只作为 `clientFacingModel()` 的兜底 */
    protected readonly initialModel: string;
    /** 客户端请求的模型名（`modelConfig.name`），只由入口设置一次，不被上游事件覆盖 */
    protected clientModel?: string;
    /** 上游实际模型名（记录/排障用，**不参与**客户端可见输出） */
    protected upstreamModel?: string;
    /**
     * 本次请求命中的上游来源标识（`vendor:<id>`），由 senderService 在选定上游后注入。
     * 封包时写进凭据、回放时用于核对：来源不同或没有来源的凭据不跨来源使用（PC-009-C）。
     */
    protected credentialSource?: string;
    /** 请求侧出现过「老凭据（无 source）⇒ 来源未校验」时置位，供入口写进 request_activity */
    protected credentialSourceUnchecked = false;
    protected responseId: string;
    protected contentBlockIndex = 0;
    /** Responses 流事件的 sequence_number 计数 */
    protected seq = 0;
    /**
     * 本次转换中记录里的 stop_reason 是谁给的：null = 还没走到能确定的收尾点。
     * 由各转换器在「确认上游给了 finish_reason」或「我方兜底合成」的那一刻写入；
     * 供 handler 收尾时写进 request_activity（见 responseHandlerService）。
     */
    protected stopReasonSource: StopReasonSource | null = null;

    constructor(requestModel: string = "unknown", responseId?: string) {
        this.requestModel = requestModel;
        this.initialModel = requestModel;
        this.responseId = responseId || `chatcmpl-${Date.now()}`;
    }

    /**
     * 将请求体字符串转换为上游所需格式的字符串
     */
    public convertRequestBody(bodyStr: string): string {
        let bodyJson: unknown;
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
            // 转换器自己抛的 AppError（如"不支持的内容块类型"）保留文案与状态码，
            // 但要补上 failed_code，避免终态失败在记录里被糊成 unknown_error。
            if (customError.isAppError(e)) {
                if (e.failedCode) throw e;
                throw new customError.AppError(e.message, e.statusCode, e.code, FailedCode.CONVERSION_ERROR);
            }
            throw new customError.AppError(
                `Protocol conversion failed: ${e instanceof Error ? e.message : String(e)}`,
                400,
                undefined,
                FailedCode.CONVERSION_ERROR,
            );
        }
    }

    /**
     * 更新请求模型名称（常用于提取请求体后或第一条流式响应到来时）。
     *
     * 注意它会被上游事件覆盖成**上游实际模型名**，所以面向客户端的输出与凭据绑定**不能**读它，
     * 一律走 `clientFacingModel()` / `clientModel`（§4.7 / PC-009-C）。
     */
    public updateModel(model: string) {
        this.requestModel = model;
        this.upstreamModel = model;
    }

    /**
     * 更新「客户端请求的模型名」（`modelConfig.name`）。
     *
     * 与 `requestModel` 的区别是本 single 修复的核心（PC-009-C / §4.7）：
     * - `requestModel` 会被**上游流事件**（`message_start` / `chunk.model`）反复覆盖成
     *   上游实际模型名，也可能被调用方写成 vendor 名 —— 它反映「这次请求打到上游时用的名字」；
     * - `clientModel` 只在请求进入网关时设置一次，**永不**被上游事件覆盖，是「客户端认得的身份」。
     *
     * 响应里的 `model` 字段与 thinking 凭据的模型绑定都用 `clientModel`：
     * 否则别名路由（客户端 `alias` → 上游 `actual-version`）下，客户端看到的模型名与它发出去的不一致，
     * 下一轮回放还会因「封包用上游名、解封用另一侧名字」被网关自己判成不兼容。
     */
    public updateClientModel(model: string) {
        this.clientModel = model;
    }

    /**
     * 设置本次请求的上游来源标识（`vendor:<id>`）。封包与解封两侧都用它做来源绑定：
     * 同一个模型名可能由多个供应商提供，凭据跨供应商使用没有意义（上游会拒绝），
     * 在网关侧明确拒绝比把上游的报错原样透传更好排障（PC-009-C）。
     */
    public setCredentialSource(source: string) {
        this.credentialSource = source;
    }

    /**
     * 本次请求是否出现过「来源未校验」的凭据（老凭据封包里没有 `source` 字段）。
     *
     * 为什么必须暴露出来：未校验来源是**已知缺口**（凭据无 TTL，窗口长期存在），
     * 静默通过等于让缺口不可观测；入口据此在 request_activity 里留一条 warn 记录。
     */
    public isCredentialSourceUnchecked(): boolean {
        return this.credentialSourceUnchecked;
    }

    /**
     * 面向客户端的稳定模型名，退让顺序：
     * 1. `clientModel`：入口（senderService）注入的客户端请求名 —— 生产路径一定有，是唯一权威；
     * 2. `initialModel`：构造时已知的模型名（老调用点 / 单测直连转换器）；
     * 3. `fallback`：调用点给的天然兜底（如 `upstreamRes.model`）；
     * 4. `upstreamModel`：流事件里记录的上游名，仅在前三者都拿不到时兜底，避免输出 `"unknown"`。
     *
     * 第 3/4 步只服务「根本没有客户端身份信息」的退化场景，**不要**拿它们当正常路径：
     * 生产路径靠第 1 步，否则 §4.7（响应 model == 客户端请求名）立刻失效。
     */
    protected clientFacingModel(fallback?: string): string {
        // 1) 入口注入的客户端请求名（生产路径一定有）
        // 2) 构造时已知的模型名（老调用点/单测直连转换器）
        // 3) 调用点给的天然兜底（如 `upstreamRes.model`），保持「没有身份信息时不倒退」的老行为
        // 4) 流事件里记录的上游名
        if (this.clientModel) return this.clientModel;
        if (this.initialModel && this.initialModel !== "unknown") return this.initialModel;
        return fallback || this.upstreamModel || "unknown";
    }

    /**
     * 更新响应 ID
     */
    public updateResponseId(id: string) {
        this.responseId = id;
    }

    /**
     * 生成下一个 Responses 事件序号（从 1 开始）
     */
    protected nextSeq(): number {
        return ++this.seq;
    }

    /**
     * 本次转换里记录中 stop_reason 的来源；null = 本转换器尚未走到能确定的收尾点
     * （或该转换器/该路径不涉及 stop_reason 合成）。
     *
     * 只给收尾记账用，不参与任何响应输出。
     */
    public getStopReasonSource(): StopReasonSource | null {
        return this.stopReasonSource;
    }

    /**
     * 将客户端请求转换为上游请求格式
     * 外部 JSON 入口按 unknown 处理，各实现声明自己的协议类型
     */
    public abstract convertRequest(clientReq: unknown): unknown;

    /**
     * 将上游非流式响应转换为客户端非流式响应格式
     */
    public abstract convertResponse(upstreamRes: unknown, requestId?: string): unknown;

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
