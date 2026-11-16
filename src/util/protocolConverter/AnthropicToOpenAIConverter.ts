import customError from "../../customError";
import { BaseConverter } from "./BaseConverter";
import type {
    AnthropicContentBlock,
    AnthropicRequest,
    AnthropicResponse,
    AnthropicSSEEvent,
} from "../protocol/anthropicTypes";
import type { ProtocolStreamEvent } from "../protocol/commonTypes";
import type {
    OpenAIContentPart,
    OpenAIChunk,
    OpenAIMessage,
    OpenAIRequest,
    OpenAIResponse,
    OpenAIStreamToolCall,
    OpenAITool,
} from "../protocol/openaiTypes";
import {
    buildThinkingConfigFromAnthropic,
    thinkingConfigToOpenAI,
} from "./thinkingConfig";
import protocolConverterUtil, { type RawOpenAIUsage } from "./protocolConverterUtil";

const OPENAI_TO_ANTHROPIC_STOP_REASON: Record<string, string> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
};

/**
 * 一个 OpenAI tool_call（按 `delta.tool_calls[].index` 归并）在 Anthropic 侧的完整状态。
 *
 * 为什么需要独立状态：OpenAI 的参数增量在**并行工具**时是交错到达的（`index=0`、`index=1`、
 * 又回到 `index=0`），而 Anthropic 的块生命周期要求「开 → 增量 → 收」严格按块顺序排队。
 * 早先的实现拿 `tc.id` 判断「是不是新工具」，续传帧不带 id 时既认不出旧工具、也认不出新工具，
 * 于是第一个工具的参数片段被写进了下一个工具的块（PC-003-A）。
 */
interface ToolCallState {
    /** Chat 侧的工具序号（`delta.tool_calls[].index`），仅用于内部归并 */
    chatIndex: number;
    id: string;
    name: string;
    /** 已收到的完整参数串（按到达顺序拼接） */
    args: string;
    /** 其中已经以 input_json_delta 形式发给客户端的字符数（前缀长度） */
    emitted: number;
    /** 是否已发过 content_block_start */
    started: boolean;
    /** 是否已发过 content_block_stop（收口后不再发该块增量） */
    closed: boolean;
}

export class AnthropicToOpenAIConverter extends BaseConverter {
    private sentFirstChunk = false;
    private hasYieldedThinking = false;
    private isFirstChunk = true;
    private pendingStopReason: string | null = null;
    /**
     * 当前是否有一个 content block 处于「已 start、未 stop」的状态。
     *
     * Anthropic 的流是「start → delta* → stop」的块生命周期，块之间**必须**成对收口，
     * index 也必须唯一（客户端按 index 反查块：官方 SDK 用 `content.at(index)`）。
     * 之前靠 `sentFirstChunk || hasYieldedThinking` 判断「要不要先收口」，漏掉了
     * 「上一个块是 tool_use」的情形 —— 并行 tool_call 时两个块共用同一 index 且中间没有 stop，
     * 客户端会把后一个工具的参数拼到前一个工具上（见 #246）。
     */
    private blockOpen = false;
    /**
     * Chat 侧工具序号 → 工具状态（含它自己的 id/name/参数/收发进度）。
     * 键是 `delta.tool_calls[].index`，**不是**块 index：块 index 在 `toolOrder` 里按发现顺序排队分配。
     */
    private toolCalls = new Map<number, ToolCallState>();
    /** 工具的发现顺序 = 块输出顺序（Anthropic 要求块按 index 单调开通，不能乱序插队） */
    private toolOrder: number[] = [];
    /** 当前开着的块是哪个工具的 tool_use 块（null = 没开块 / 开的是 text|thinking 块） */
    private openToolChatIndex: number | null = null;
    /**
     * 最近一次落位的工具序号：部分上游续传帧既不带 `index` 也不带 `id`，只能沿用上一次的。
     */
    private lastToolChatIndex: number | null = null;
    /**
     * 累积的原始 OpenAI usage（openai 可能把 usage 拆到多个 chunk，缓存在末尾的 usage-only chunk 才出现，
     * 因此只有等到 [DONE] 才能拿到完整 usage）。逐字段保存原始值，统一在 handleDoneEvent 时派生 Anthropic 字段。
     */
    private rawUsage: RawOpenAIUsage | null = null;

    /**
     * 累积一次 openai usage 到 rawUsage，后到的 chunk 字段优先，显式 0 覆盖旧值。
     */
    private accumulateUsage(chunk: OpenAIChunk): void {
        if (!chunk.usage) return;
        if (!this.rawUsage) {
            this.rawUsage = {};
        }
        protocolConverterUtil.mergeOpenAIUsage(this.rawUsage, chunk.usage);
    }



    public convertRequest(clientReq: AnthropicRequest): OpenAIRequest {
        const messages: OpenAIRequest["messages"] = [];

        if (clientReq.system) {
            let systemContent = "";
            if (typeof clientReq.system === "string") {
                systemContent = clientReq.system;
            } else if (Array.isArray(clientReq.system)) {
                systemContent = clientReq.system.map((s) => s.text).join("\n\n");
            }
            messages.push({ role: "system", content: systemContent });
        }

        for (const msg of clientReq.messages) {
            if (msg.role === "user") {
                if (typeof msg.content === "string") {
                    messages.push({ role: "user", content: msg.content });
                } else if (Array.isArray(msg.content)) {
                    const toolResults = msg.content.filter((b) => b.type === "tool_result");
                    const normalBlocks = msg.content.filter((b) => b.type !== "tool_result");

                    // OpenAI requires tool responses to immediately follow assistant tool_calls.
                    // tool 消息只支持文本：图片从工具结果里取出，随后统一放进一条 user 消息。
                    const toolResultImages: OpenAIContentPart[] = [];
                    for (const tr of toolResults) {
                        const textContent = typeof tr.content === "string"
                            ? tr.content
                            : (tr.content ?? [])
                                .filter((b) => b.type === "text")
                                .map((b) => b.text || "")
                                .join("\n");
                        messages.push({
                            role: "tool",
                            tool_call_id: tr.tool_use_id,
                            content: textContent,
                        });

                        const imageBlocks = typeof tr.content === "string" ? [] : tr.content ?? [];
                        for (const block of imageBlocks) {
                            if (block.type !== "image") continue;
                            const url = protocolConverterUtil.anthropicImageSourceToUrl(block.source);
                            toolResultImages.push({ type: "image_url", image_url: { url } });
                        }
                    }

                    if (normalBlocks.length > 0 || toolResultImages.length > 0) {
                        messages.push({
                            role: "user",
                            content: this.convertUserContent(normalBlocks, toolResultImages),
                        });
                    }
                }
            } else if (msg.role === "assistant") {
                if (typeof msg.content === "string") {
                    messages.push({ role: "assistant", content: msg.content });
                } else if (Array.isArray(msg.content)) {
                    const textBlocks = msg.content.filter((b) => b.type === "text");
                    const thinkingBlocks = msg.content.filter((b) => b.type === "thinking");
                    const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");

                    const combinedText = textBlocks
                        .map((b) => b.text)
                        .join("\n");

                    const reasoningText = thinkingBlocks
                        .map((b) => b.thinking)
                        .join("\n");

                    const assistantMsg: OpenAIMessage = {
                        role: "assistant",
                        content: combinedText || null,
                    };
                    
                    if (thinkingBlocks.length > 0) {
                        assistantMsg.reasoning_content = reasoningText;
                    }

                    if (toolUseBlocks.length > 0) {
                        assistantMsg.tool_calls = toolUseBlocks.map((tu) => ({
                            id: tu.id || `call_${Date.now()}`,
                            type: "function",
                            function: {
                                name: tu.name || "",
                                arguments: JSON.stringify(tu.input || {}),
                            },
                        }));
                    }
                    messages.push(assistantMsg);
                }
            }
        }

        const openaiTools: OpenAITool[] | undefined = clientReq.tools?.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
            },
        }));

        let openaiToolChoice: OpenAIRequest["tool_choice"] = undefined;
        if (clientReq.tool_choice) {
            switch (clientReq.tool_choice.type) {
                case "auto":
                    openaiToolChoice = "auto";
                    break;
                case "any":
                    openaiToolChoice = "required";
                    break;
                case "none":
                    openaiToolChoice = "none";
                    break;
                case "tool":
                    openaiToolChoice = {
                        type: "function",
                        function: { name: clientReq.tool_choice.name || "" },
                    };
                    break;
            }
        }

        const openaiReq: OpenAIRequest = {
            model: clientReq.model,
            messages,
            max_tokens: clientReq.max_tokens,
            stream: clientReq.stream,
            temperature: clientReq.temperature,
            top_p: clientReq.top_p,
            stop: clientReq.stop_sequences,
        };

        if (openaiTools) {
            openaiReq.tools = openaiTools;
        }
        if (openaiToolChoice) {
            openaiReq.tool_choice = openaiToolChoice;
        }
        const reasoningEffort = thinkingConfigToOpenAI(
            buildThinkingConfigFromAnthropic(clientReq.thinking, clientReq.output_config),
        );
        if (reasoningEffort) {
            openaiReq.reasoning_effort = reasoningEffort;
        }

        return openaiReq;
    }


    /**
     * Anthropic 普通 user 内容块 → OpenAI content：
     * - 无图片时保持原有的文本拼接行为
     * - 含图片时输出多模态 parts，保留文本与图片的原始顺序
     * - extraImageParts 承接从 tool_result 中拆出的图片，追加在普通内容之后
     */
    private convertUserContent(
        blocks: AnthropicContentBlock[],
        extraImageParts: OpenAIContentPart[] = [],
    ): string | OpenAIContentPart[] {
        const hasImage = extraImageParts.length > 0
            || blocks.some((b) => b.type === "image");
        if (!hasImage) {
            return blocks.map((b) => b.text || "").join("\n");
        }

        const parts: OpenAIContentPart[] = [];
        for (const block of blocks) {
            if (block.type === "text") {
                if (block.text) {
                    parts.push({ type: "text", text: block.text });
                }
            } else if (block.type === "image") {
                const url = protocolConverterUtil.anthropicImageSourceToUrl(block.source);
                parts.push({ type: "image_url", image_url: { url } });
            }
        }
        parts.push(...extraImageParts);
        return parts.length > 0 ? parts : "";
    }


    public convertResponse(upstreamRes: OpenAIResponse, requestId?: string): AnthropicResponse {
        // 记录上游名（仅作无客户端身份时的兜底，不参与正常路径的客户端可见输出）
        if (upstreamRes?.model) this.upstreamModel = upstreamRes.model;
        const message = upstreamRes.choices[0]?.message;
        const contentBlocks: AnthropicContentBlock[] = [];

        if (message?.reasoning_content) {
            contentBlocks.push({
                type: "thinking",
                thinking: message.reasoning_content,
            });
        }

        if (message?.content) {
            contentBlocks.push({ type: "text", text: message.content });
        }

        if (message?.tool_calls) {
            for (const tc of message.tool_calls) {
                let inputObj: Record<string, unknown> = {};
                try {
                    inputObj = JSON.parse(tc.function.arguments);
                } catch {
                    inputObj = { raw: tc.function.arguments };
                }
                contentBlocks.push({
                    type: "tool_use",
                    id: tc.id,
                    name: tc.function.name,
                    input: inputObj,
                });
            }
        }

        if (contentBlocks.length === 0) {
            contentBlocks.push({ type: "text", text: "" });
        }

        const upstreamFinishReason = upstreamRes.choices[0]?.finish_reason ?? null;
        const stopReason = OPENAI_TO_ANTHROPIC_STOP_REASON[upstreamFinishReason || "stop"] || "end_turn";
        // 来源标记：上游给了 finish_reason 才算 upstream；缺失时下面的 `|| "stop"` 与
        // 映射默认值都是我方补的，记 synthesized（只用于记账，不影响输出取值）。
        this.stopReasonSource = upstreamFinishReason ? "upstream" : "synthesized";
        const finalId = requestId || upstreamRes.id;

        return {
            id: finalId.startsWith("msg_") ? finalId : `msg_${finalId.replace("chatcmpl-", "")}`,
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: this.clientFacingModel(),
            stop_reason: stopReason as AnthropicResponse["stop_reason"],
            usage: protocolConverterUtil.openAIUsageToAnthropic(
                protocolConverterUtil.mergeOpenAIUsage({}, upstreamRes.usage),
            ),
        };
    }


    public override onUpstreamEnd(): ProtocolStreamEvent[] {
        // 上游给过 finish_reason（stop_reason 已暂存）却没见 [DONE]：补齐 message_delta + message_stop。
        // 上游真发过 [DONE] 时 handleDoneEvent 已把 pendingStopReason 清空，这里返回空、不重复补发。
        return this.pendingStopReason !== null ? this.handleDoneEvent() : [];
    }


    protected override handleDoneEvent(): ProtocolStreamEvent[] {
        // [DONE] 是上游 openai 流的明确收尾标记,此时所有 usage chunk(含缓存在内的
        // 尾随 usage-only chunk)一定都已到达,统一在这里聚合发出最终的
        // message_delta(携带累积的 usage)+ message_stop。
        const usage = protocolConverterUtil.openAIUsageToAnthropic(this.rawUsage ?? {});
        // 来源标记：pendingStopReason 非空 = 上游给过 finish_reason（值经映射表换算）；
        // 为空 = 上游漏发收尾信号，下面的 `?? "end_turn"` 是我方兜底（#246 的 D2 路径）。
        this.stopReasonSource = this.pendingStopReason !== null ? "upstream" : "synthesized";
        const stopReason = this.pendingStopReason ?? "end_turn";
        const events: AnthropicSSEEvent[] = [];

        // 上游可能不给 finish_reason 就直接 [DONE]（兼容上游确实这么干）：此时块还开着，
        // 规范流程要求 message_delta / message_stop 之前所有块都已 content_block_stop。
        this.flushToolBlocks(events);
        if (this.blockOpen) {
            events.push({
                event: "content_block_stop",
                data: JSON.stringify({
                    type: "content_block_stop",
                    index: this.contentBlockIndex,
                }),
            });
            this.blockOpen = false;
        }

        events.push(
            {
                event: "message_delta",
                data: JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage,
                }),
            },
            {
                event: "message_stop",
                data: JSON.stringify({ type: "message_stop" }),
            },
        );
        this.pendingStopReason = null;
        return events;
    }


    // ─── 块生命周期工具方法（text / thinking / tool_use 共用一套开合规则） ───

    /** 收口当前打开的块（若有），块 index 顺延；顺带清掉 text/thinking 的「已开过」标记。 */
    private closeCurrentBlock(events: AnthropicSSEEvent[]): void {
        if (!this.blockOpen) return;
        events.push({
            event: "content_block_stop",
            data: JSON.stringify({
                type: "content_block_stop",
                index: this.contentBlockIndex,
            }),
        });
        if (this.openToolChatIndex !== null) {
            const tool = this.toolCalls.get(this.openToolChatIndex);
            if (tool) tool.closed = true;
            this.openToolChatIndex = null;
        }
        this.blockOpen = false;
        this.sentFirstChunk = false;
        this.hasYieldedThinking = false;
        this.contentBlockIndex++;
    }

    /** 开一个非工具块（text / thinking）。调用前由 closeCurrentBlock 保证没有别的块开着。 */
    private openPlainBlock(events: AnthropicSSEEvent[], contentBlock: Record<string, unknown>): void {
        this.closeCurrentBlock(events);
        events.push({
            event: "content_block_start",
            data: JSON.stringify({
                type: "content_block_start",
                index: this.contentBlockIndex,
                content_block: contentBlock,
            }),
        });
        this.blockOpen = true;
    }

    /** 把某个工具尚未发送的参数片段一次性发完（input_json_delta 允许任意切分，包含整串）。 */
    private emitToolArgs(events: AnthropicSSEEvent[], tool: ToolCallState): void {
        const pending = tool.args.slice(tool.emitted);
        if (!pending) return;
        events.push({
            event: "content_block_delta",
            data: JSON.stringify({
                type: "content_block_delta",
                index: this.contentBlockIndex,
                delta: { type: "input_json_delta", partial_json: pending },
            }),
        });
        tool.emitted = tool.args.length;
    }

    /** 开某个工具的 tool_use 块（调用前由 closeCurrentBlock 保证没有别的块开着）。 */
    private openToolBlock(events: AnthropicSSEEvent[], tool: ToolCallState): void {
        this.closeCurrentBlock(events);
        events.push({
            event: "content_block_start",
            data: JSON.stringify({
                type: "content_block_start",
                index: this.contentBlockIndex,
                content_block: {
                    type: "tool_use",
                    id: tool.id,
                    name: tool.name,
                    input: {},
                },
            }),
        });
        tool.started = true;
        this.blockOpen = true;
        this.openToolChatIndex = tool.chatIndex;
    }

    /** 该工具是否是「按块顺序该轮到的下一个」（排在它前面的工具都已收口）。 */
    private isNextToolToStart(tool: ToolCallState): boolean {
        for (const chatIndex of this.toolOrder) {
            if (chatIndex === tool.chatIndex) return true;
            const earlier = this.toolCalls.get(chatIndex);
            if (earlier && !earlier.closed) return false;
        }
        return false;
    }

    /**
     * 把还没收口的工具块按顺序补齐并收口。
     *
     * Chat 上游在并行工具时会交错下发参数，而 Anthropic 客户端按块 index 反查、
     * 要求块「开 → 增量 → 收」严格排队，所以交错片段先攒在各自工具的 args 里，
     * 等这一轮的轮次到了再顺序吐出去（见 PC-003-A）。
     */
    private flushToolBlocks(events: AnthropicSSEEvent[]): void {
        for (const chatIndex of this.toolOrder) {
            const tool = this.toolCalls.get(chatIndex);
            if (!tool || tool.closed) continue;
            if (this.openToolChatIndex === tool.chatIndex) {
                // 已开着的块：把剩余参数补发完再收口
                this.emitToolArgs(events, tool);
                this.closeCurrentBlock(events);
            } else {
                // 还没开块：开块 → 一次性补发全部参数 → 收口
                this.openToolBlock(events, tool);
                this.emitToolArgs(events, tool);
                this.closeCurrentBlock(events);
            }
        }
    }

    /**
     * 把一条 tool_call 增量归并到它的 Chat 工具序号上。
     *
     * 优先用 `index`（并行工具时它是唯一的稳定标识）；退化顺序：`id` 反查 → 上一次落位的序号。
     */
    private resolveToolChatIndex(tc: OpenAIStreamToolCall): number {
        if (typeof tc.index === "number") {
            this.lastToolChatIndex = tc.index;
            return tc.index;
        }
        if (tc.id) {
            for (const [chatIndex, tool] of this.toolCalls) {
                if (tool.id === tc.id) {
                    this.lastToolChatIndex = chatIndex;
                    return chatIndex;
                }
            }
        }
        const fallback = this.lastToolChatIndex ?? 0;
        this.lastToolChatIndex = fallback;
        return fallback;
    }

    protected doConvertStreamEvent(data: Record<string, unknown>, rawDataStr: string): ProtocolStreamEvent[] {
        if (data.error || data.type === "error") {
            return [{ data: rawDataStr, event: "error" }];
        }

        const events: AnthropicSSEEvent[] = [];
        const chunk = data as unknown as OpenAIChunk;

        if (this.isFirstChunk) {
            this.isFirstChunk = false;
            if (chunk.model) this.updateModel(chunk.model);
            if (chunk.id) {
                this.updateResponseId(chunk.id.startsWith("msg_") ? chunk.id : `msg_${chunk.id.replace("chatcmpl-", "")}`);
            }

            events.push({
                event: "message_start",
                data: JSON.stringify({
                    type: "message_start",
                    message: {
                        id: this.responseId,
                        type: "message",
                        role: "assistant",
                        model: this.clientFacingModel(),
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                    },
                }),
            });
        }

        if (chunk.choices && chunk.choices.length > 0) {
            const delta = chunk.choices[0].delta;

            if (delta.reasoning_content) {
                if (!this.hasYieldedThinking) {
                    // 工具块还开着时必须先按顺序把工具块补齐收口，才能开 thinking 块
                    this.flushToolBlocks(events);
                    this.openPlainBlock(events, { type: "thinking", thinking: "" });
                    this.hasYieldedThinking = true;
                }
                events.push({
                    event: "content_block_delta",
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: this.contentBlockIndex,
                        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
                    }),
                });
            }

            if (delta.content) {
                if (!this.sentFirstChunk) {
                    this.flushToolBlocks(events);
                    this.openPlainBlock(events, { type: "text", text: "" });
                    this.sentFirstChunk = true;
                }

                events.push({
                    event: "content_block_delta",
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: this.contentBlockIndex,
                        delta: { type: "text_delta", text: delta.content },
                    }),
                });
            }

            if (delta.tool_calls && delta.tool_calls.length > 0) {
                for (const tc of delta.tool_calls) {
                    const chatIndex = this.resolveToolChatIndex(tc);
                    let tool = this.toolCalls.get(chatIndex);

                    if (!tool) {
                        // 首次见到这个工具：登记它，块 index 在真正开通时才按 toolOrder 顺序分配
                        tool = {
                            chatIndex,
                            id: tc.id || `call_${chatIndex}`,
                            name: tc.function?.name || "",
                            args: "",
                            emitted: 0,
                            started: false,
                            closed: false,
                        };
                        this.toolCalls.set(chatIndex, tool);
                        this.toolOrder.push(chatIndex);
                    } else {
                        // 续传帧：有的上游只在首帧给 id/name，缺了就补上
                        if (!tool.id && tc.id) tool.id = tc.id;
                        if (!tool.name && tc.function?.name) tool.name = tc.function.name;
                    }

                    const argChunk = tc.function?.arguments || "";
                    if (argChunk) tool.args += argChunk;

                    if (this.openToolChatIndex === chatIndex) {
                        // 当前开着的正是它的块：参数可以立刻增量下发
                        this.emitToolArgs(events, tool);
                    } else if (!tool.started && this.openToolChatIndex === null && this.isNextToolToStart(tool)) {
                        // 没开工具块（可能开着 text/thinking）且按顺序轮到它：开块并发参数
                        this.openToolBlock(events, tool);
                        this.emitToolArgs(events, tool);
                    }
                    // 其余情况（上一个工具块还没收口）：参数先攒在 tool.args 里，
                    // 等 flushToolBlocks 按顺序吐出去，避免交错片段写进别的工具的块
                }
            }

            if (chunk.choices[0].finish_reason) {
                this.flushToolBlocks(events);
                if (this.blockOpen) {
                    events.push({
                        event: "content_block_stop",
                        data: JSON.stringify({
                            type: "content_block_stop",
                            index: this.contentBlockIndex,
                        }),
                    });
                    this.blockOpen = false;
                    this.contentBlockIndex++;
                }

                const stopReason = OPENAI_TO_ANTHROPIC_STOP_REASON[chunk.choices[0].finish_reason] || "end_turn";

                // 只记录 stop_reason; message_delta/message_stop 统一在
                // [DONE] 时聚合发出(避免像 deepseek 那样把最终 usage、缓存拆到
                // finish_reason 之后的 choices:[] 尾随 chunk 时被过早发出的 message_stop 丢掉)
                this.pendingStopReason = stopReason;
            }
        }

        // 任何 chunk 携带 usage（含与 finish_reason 同帧或尾随 choices=[]）都累积原始字段
        if (chunk.usage) {
            this.accumulateUsage(chunk);
        }

        return events;
    }
}
