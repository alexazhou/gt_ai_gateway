/**
 * OpenAI Responses API SSE 消息累加器
 * 用于累积流式 Responses API 响应，生成完整的响应对象
 *
 * 事件处理逻辑：
 * - response.created       → 保存 id, model, created_at, object
 * - response.output_item.added  → 初始化 output 数组中对应位置的 item
 * - response.content_part.added → 初始化 content 数组中对应位置的 part
 * - response.output_text.delta  → 累积文本增量
 * - response.output_text.done   → 用完整文本覆盖（更可靠）
 * - response.output_item.done   → 更新 item status 和最终 content
 * - response.completed     → 用完整 response 对象覆盖（包含 usage）
 */

import type { ProtocolStreamEvent } from "../protocol/commonTypes";
import type {
    ResponsesStreamContentPart,
    ResponsesStreamItem,
    ResponsesSummaryPart,
} from "../protocol/responsesTypes";
import { AccumulatorBase } from "./accumulatorBase";

/** 累加器内部的可变部分视图（按 output item 类型保留字段，不强制非 message 项带 content） */
interface ResponsesAccumulatorOutputItem {
    id?: string;
    type?: string;
    role?: string;
    status?: string;
    content?: ResponsesStreamContentPart[];
    call_id?: string;
    name?: string;
    arguments?: string;
    encrypted_content?: string;
    summary?: ResponsesSummaryPart[];
}

/** SSE 事件中累加器实际读取的字段 */
interface ResponsesAccumulatorEvent {
    type?: string;
    error?: unknown;
    response?: {
        id?: string;
        object?: string;
        created_at?: number;
        model?: string;
        status?: string;
        incomplete_details?: { reason?: string } | null;
        completed_at?: number;
        output?: ResponsesAccumulatorOutputItem[];
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
        };
    };
    output_index?: number;
    content_index?: number;
    summary_index?: number;
    item?: ResponsesStreamItem;
    part?: ResponsesStreamContentPart | ResponsesSummaryPart;
    delta?: string;
    text?: string;
    arguments?: string;
}

/**
 * 归一化后的 usage（统一 OpenAI 口径键：prompt_tokens 为含缓存的输入总量，cache_read_tokens 为其子集）。
 * 上游 Responses 原生键（input_tokens / input_tokens_details.cached_tokens）在落地时转换。
 * 缺失字段为 null，明确返回 0 则为 0（与 SgRecordUsage 同口径）。
 */
interface ResponsesUsage {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cache_read_tokens?: number | null;
}

interface ResponsesAccumulatedResponse {
    id?: string;
    object?: string;
    created_at?: number;
    model?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    output: ResponsesAccumulatorOutputItem[];
    usage?: ResponsesUsage;
    completed_at?: number;
}

export class ResponsesAccumulator extends AccumulatorBase {
    // 标记“模型已开始产出内容”的事件类型。
    // 这些事件出现即表示首个输出 token 已到达（区别于 response.created/in_progress 等前置控制事件）。
    private static OUTPUT_STARTED_EVENTS = new Set([
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.function_call_arguments.delta",
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_part.added",
    ]);

    private response: ResponsesAccumulatedResponse = {
        output: [],
    };


    /**
     * 添加一条 Responses API 客户端 SSE 事件（原始 data 字符串）
     * 内部解析为 ResponsesStreamEvent 并检测完成/错误/首个输出，与 OpenAIChatAccumulator.addEvent 同构。
     */
    addEvent(clientEvent: ProtocolStreamEvent): void {
        let event: ResponsesAccumulatorEvent;
        try {
            event = JSON.parse(clientEvent.data) as ResponsesAccumulatorEvent;
        } catch {
            this.markParseFailed();
            return;
        }
        const eventName = clientEvent.event;
        const type: string = event.type ?? "";

        if (ResponsesAccumulator.OUTPUT_STARTED_EVENTS.has(type)) {
            this.markOutputStarted();
        }

        if (this.isErrorEvent(event, eventName)) {
            this.markError(event);
            return;
        }

        if (type === "response.created" || type === "response.in_progress") {
            this.handleResponseCreated(event.response);
            return;
        }

        if (type === "response.output_item.added") {
            this.handleOutputItemAdded(event.output_index ?? 0, event.item);
            return;
        }

        if (type === "response.content_part.added") {
            this.handleContentPartAdded(
                event.output_index ?? 0,
                event.content_index ?? 0,
                event.part as ResponsesStreamContentPart | undefined,
            );
            return;
        }

        if (type === "response.output_text.delta") {
            this.handleOutputTextDelta(event.output_index ?? 0, event.content_index ?? 0, event.delta ?? "");
            return;
        }

        if (type === "response.output_text.done") {
            this.handleOutputTextDone(event.output_index ?? 0, event.content_index ?? 0, event.text ?? "");
            return;
        }

        if (type === "response.function_call_arguments.delta") {
            this.handleFunctionCallArgsDelta(event.output_index ?? 0, event.delta ?? "");
            return;
        }

        if (type === "response.function_call_arguments.done") {
            this.handleFunctionCallArgsDone(event.output_index ?? 0, event.arguments);
            return;
        }

        if (type === "response.reasoning_summary_part.added") {
            this.handleReasoningSummaryPartAdded(
                event.output_index ?? 0,
                event.summary_index ?? 0,
                event.part as ResponsesSummaryPart | undefined,
            );
            return;
        }

        if (type === "response.reasoning_summary_text.delta") {
            this.handleReasoningSummaryTextDelta(event.output_index ?? 0, event.summary_index ?? 0, event.delta ?? "");
            return;
        }

        if (type === "response.reasoning_summary_text.done") {
            this.handleReasoningSummaryTextDone(event.output_index ?? 0, event.summary_index ?? 0, event.text ?? "");
            return;
        }

        if (type === "response.reasoning_summary_part.done") {
            this.handleReasoningSummaryPartDone(
                event.output_index ?? 0,
                event.summary_index ?? 0,
                event.part as ResponsesSummaryPart | undefined,
            );
            return;
        }

        if (type === "response.output_item.done") {
            this.handleOutputItemDone(event.output_index ?? 0, event.item);
            return;
        }

        if (type === "response.completed" || type === "response.incomplete") {
            this.markCompleted();
            this.handleResponseCompleted(event.response);
            return;
        }
    }


    // error 字段判 != null 而不是判真假：正常的 Responses 响应里会带 error: null，不算失败。
    // 最后那个 error 非空判断是兜底：有些上游不带上面两种 type，直接把错误对象放在顶层。
    private isErrorEvent(event: ResponsesAccumulatorEvent, eventName?: string): boolean {
        return eventName === "error"
            || event.type === "error"
            || event.type === "response.failed"
            || event.error != null;
    }


    private handleResponseCreated(responseObj: ResponsesAccumulatorEvent["response"]): void {
        if (!responseObj) return;
        if (responseObj.id) this.response.id = responseObj.id;
        if (responseObj.object) this.response.object = responseObj.object;
        if (responseObj.created_at) this.response.created_at = responseObj.created_at;
        if (responseObj.model) this.response.model = responseObj.model;
        if (responseObj.status) this.response.status = responseObj.status;
    }


    private ensureOutputItem(outputIndex: number): void {
        while (this.response.output.length <= outputIndex) {
            this.response.output.push({});
        }
    }


    private handleOutputItemAdded(outputIndex: number, item: ResponsesStreamItem | undefined): void {
        this.ensureOutputItem(outputIndex);
        if (!item) return;
        const existing = this.response.output[outputIndex];
        const next: ResponsesAccumulatorOutputItem = {
            ...existing,
            id: item.id ?? existing.id,
            type: item.type ?? existing.type,
            role: item.role ?? existing.role,
            status: item.status ?? existing.status,
        };
        if (item.type === "message") {
            next.content = item.content ?? existing.content ?? [];
        } else if (item.content !== undefined) {
            next.content = item.content;
        }
        if (item.call_id !== undefined) next.call_id = item.call_id;
        if (item.name !== undefined) next.name = item.name;
        if (item.arguments !== undefined) next.arguments = item.arguments;
        if (item.encrypted_content !== undefined) next.encrypted_content = item.encrypted_content;
        if (item.summary !== undefined) next.summary = item.summary;
        this.response.output[outputIndex] = next;
    }


    private handleContentPartAdded(
        outputIndex: number,
        contentIndex: number,
        part: ResponsesStreamContentPart | undefined,
    ): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        if (!item.content) item.content = [];

        while (item.content.length <= contentIndex) {
            item.content.push({});
        }

        if (part) {
            item.content[contentIndex] = {
                type: part.type ?? item.content[contentIndex].type,
                text: part.text ?? item.content[contentIndex].text ?? "",
                annotations: part.annotations ?? item.content[contentIndex].annotations ?? [],
            };
        }
    }


    private handleOutputTextDelta(outputIndex: number, contentIndex: number, delta: string): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        if (!item.content) item.content = [];

        while (item.content.length <= contentIndex) {
            item.content.push({ text: "" });
        }

        item.content[contentIndex].text = (item.content[contentIndex].text ?? "") + delta;
    }


    private handleOutputTextDone(outputIndex: number, contentIndex: number, text: string): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        if (!item.content) item.content = [];

        while (item.content.length <= contentIndex) {
            item.content.push({});
        }

        // 用完整文本覆盖增量累积的结果，确保准确
        item.content[contentIndex].text = text;
    }


    private handleFunctionCallArgsDelta(outputIndex: number, delta: string): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        item.arguments = (item.arguments ?? "") + delta;
    }


    private handleFunctionCallArgsDone(outputIndex: number, args: string | undefined): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        if (args !== undefined) {
            item.arguments = args;
        }
    }


    private ensureSummarySlot(item: ResponsesAccumulatorOutputItem, summaryIndex: number): ResponsesSummaryPart[] {
        if (!item.summary) item.summary = [];
        while (item.summary.length <= summaryIndex) {
            item.summary.push({ type: "summary_text", text: "" });
        }
        return item.summary;
    }


    private handleReasoningSummaryPartAdded(
        outputIndex: number,
        summaryIndex: number,
        part: ResponsesSummaryPart | undefined,
    ): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        const summary = this.ensureSummarySlot(item, summaryIndex);
        if (part) {
            summary[summaryIndex] = {
                type: part.type ?? summary[summaryIndex].type ?? "summary_text",
                text: part.text ?? summary[summaryIndex].text ?? "",
            };
        }
    }


    private handleReasoningSummaryTextDelta(outputIndex: number, summaryIndex: number, delta: string): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        const summary = this.ensureSummarySlot(item, summaryIndex);
        summary[summaryIndex].text = (summary[summaryIndex].text ?? "") + delta;
    }


    private handleReasoningSummaryTextDone(outputIndex: number, summaryIndex: number, text: string): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        const summary = this.ensureSummarySlot(item, summaryIndex);
        summary[summaryIndex].text = text;
    }


    private handleReasoningSummaryPartDone(
        outputIndex: number,
        summaryIndex: number,
        part: ResponsesSummaryPart | undefined,
    ): void {
        this.ensureOutputItem(outputIndex);
        const item = this.response.output[outputIndex];
        const summary = this.ensureSummarySlot(item, summaryIndex);
        if (part) {
            summary[summaryIndex] = {
                type: part.type ?? summary[summaryIndex].type ?? "summary_text",
                text: part.text ?? summary[summaryIndex].text ?? "",
            };
        }
    }


    private handleOutputItemDone(outputIndex: number, item: ResponsesStreamItem | undefined): void {
        if (!item) return;
        this.ensureOutputItem(outputIndex);
        const existing = this.response.output[outputIndex];

        const next: ResponsesAccumulatorOutputItem = {
            ...existing,
            id: item.id ?? existing.id,
            type: item.type ?? existing.type,
            role: item.role ?? existing.role,
            status: item.status ?? existing.status,
        };
        if (item.content !== undefined) next.content = item.content;
        if (item.call_id !== undefined) next.call_id = item.call_id;
        if (item.name !== undefined) next.name = item.name;
        if (item.arguments !== undefined) next.arguments = item.arguments;
        if (item.encrypted_content !== undefined) next.encrypted_content = item.encrypted_content;
        if (item.summary !== undefined) next.summary = item.summary;
        this.response.output[outputIndex] = next;
    }


    /**
     * Responses 原生 usage → 归一化口径（prompt_tokens 总量含缓存 / completion_tokens / cache_read_tokens）
     */
    private toCanonicalUsage(
        usage: NonNullable<ResponsesAccumulatorEvent["response"]>["usage"],
    ): ResponsesUsage | undefined {
        if (!usage) return undefined;
        return {
            prompt_tokens: usage.input_tokens ?? null,
            completion_tokens: usage.output_tokens ?? null,
            cache_read_tokens: usage.input_tokens_details?.cached_tokens ?? null,
        };
    }


    private handleResponseCompleted(responseObj: ResponsesAccumulatorEvent["response"]): void {
        if (!responseObj) return;
        // response.completed 包含最终完整的 response 对象，直接覆盖
        if (responseObj.id) this.response.id = responseObj.id;
        if (responseObj.object) this.response.object = responseObj.object;
        if (responseObj.created_at) this.response.created_at = responseObj.created_at;
        if (responseObj.model) this.response.model = responseObj.model;
        if (responseObj.status) this.response.status = responseObj.status;
        if (responseObj.incomplete_details !== undefined) {
            this.response.incomplete_details = responseObj.incomplete_details;
        }
        if (Array.isArray(responseObj.output) && (responseObj.output.length > 0 || this.response.output.length === 0)) {
            this.response.output = responseObj.output;
        }
        if (responseObj.usage) this.response.usage = this.toCanonicalUsage(responseObj.usage);
        if (responseObj.completed_at) this.response.completed_at = responseObj.completed_at;
    }


    /**
     * 获取当前累积的完整响应对象
     */
    getResponse(): ResponsesAccumulatedResponse {
        return this.response;
    }


    /**
     * 获取最终 usage
     */
    getUsage(): ResponsesUsage | null {
        return this.response.usage ?? null;
    }


    /**
     * 获取累积的 message 纯文本内容（跳过 reasoning / function_call 等非 message 项）
     */
    getText(): string {
        return this.response.output
            .filter((item) => item.type === "message" && Array.isArray(item.content))
            .flatMap((item) => item.content!)
            .filter((p) => p.type === "output_text" || p.text !== undefined)
            .map((p) => p.text ?? "")
            .join("");
    }


    /**
     * 重置累加器
     */
    reset(): void {
        this.response = { output: [] };
        this.resetState();
    }
}

export default {
    ResponsesAccumulator,
};
