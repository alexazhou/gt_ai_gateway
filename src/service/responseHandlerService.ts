import { Context } from "hono";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import { StatusCode } from "hono/utils/http-status";
import type { WriteStream } from "fs";
import { SgModel } from "../model/sgModel";
import { SgUser } from "../model/sgUser";
import { SgRecord } from "../model/sgRecord";
import { ApiFormat, FailedCode, SgRecordStatus, RequestActivityStage, ActivityLevel } from "../constants";
import { BaseConverter } from "../util/protocolConverter/BaseConverter";
import { AccumulatorBase } from "../util/accumulator/accumulatorBase";
import recordService from "./recordService";
import requestActivityService from "./requestActivityService";
import userService from "./userService";
import streamLogService from "./streamLogService";
import usageUtils, { type Dict } from "../util/protocol/usageUtil";
import openaiChatAccumulator from "../util/accumulator/openaiChatAccumulator";
import anthropicAccumulator from "../util/accumulator/anthropicAccumulator";
import responsesAccumulator from "../util/accumulator/responsesAccumulator";
import sseEvent from "../util/protocol/sseEventUtil";
import { runInBackground } from "../util/runInBackgroundUtil";
import customError from "../util/customErrorUtil";


// ====================================================================
// 内部类型
// ====================================================================

interface StreamRunResult {
    accumulator: AccumulatorBase;
    firstTokenTime: number | null;
    failedCode: string | null;
    streamErrorData: unknown | null;
    eventCount: number;
}


interface RunSseLoopOptions {
    accumulator: AccumulatorBase;
    converter: BaseConverter | null;
    logPrefix: string;
}


// ====================================================================
// 内部方法
// ====================================================================

/**
 * 消费上游 SSE 流：decode → 拆分事件 → 协议转换 → 累加 → 实时转发给客户端。
 * 返回统一状态供收尾使用（finalizeStreamResult）。
 */
async function runSseLoop(
    c: Context,
    upstreamRes: Response,
    stream: SSEStreamingApi,
    logStream: WriteStream | null,
    opts: RunSseLoopOptions,
): Promise<StreamRunResult> {
    const { accumulator } = opts;
    const reader = upstreamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventCount = 0;
    let failedCode: string | null = null;
    let streamErrorData: unknown | null = null;
    let firstTokenTime: number | null = null;

    const abortHandler = () => {
        if (!failedCode) failedCode = FailedCode.CLIENT_DISCONNECTED;
        reader.cancel().catch(() => {});
    };
    c.req.raw.signal.addEventListener("abort", abortHandler);

    try {
        while (true) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
                const result = await reader.read();
                done = result.done;
                value = result.value;
            } catch (e: any) {
                console.error(`${opts.logPrefix} Upstream read error:`, e);
                if (failedCode !== FailedCode.CLIENT_DISCONNECTED) {
                    failedCode = FailedCode.UPSTREAM_DISCONNECTED;
                }
                break;
            }
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            streamLogService.appendStreamLog(logStream, chunk);
            buffer += chunk;

            const splitResult = sseEvent.splitEvents(buffer);
            const events = splitResult.events;
            buffer = splitResult.remainingBuffer;

            let clientDisconnected = false;
            for (const event of events) {
                if (!event.trim()) continue;

                eventCount++;

                const parsedEvent = sseEvent.parseEvent(event);
                if (!parsedEvent) continue;

                const clientEvents = opts.converter
                    ? opts.converter.convertStreamEvent(parsedEvent.data, parsedEvent.event, parsedEvent.id)
                    : [parsedEvent];

                for (const clientEvent of clientEvents) {
                    if (!clientEvent.data) continue;

                    accumulator.addEvent(clientEvent);

                    if (firstTokenTime === null && accumulator.isOutputStarted()) {
                        firstTokenTime = Date.now();
                    }

                    if (accumulator.isErrored()) {
                        if (
                            failedCode !== FailedCode.CLIENT_DISCONNECTED
                            && failedCode !== FailedCode.UPSTREAM_DISCONNECTED
                        ) {
                            failedCode = FailedCode.UPSTREAM_ERROR;
                        }
                        streamErrorData = accumulator.getError()
                            ?? { event: clientEvent.event, data: clientEvent.data };
                    }

                    try {
                        await stream.writeSSE({
                            data: clientEvent.data,
                            event: clientEvent.event,
                            id: clientEvent.id,
                        });
                    } catch (e: any) {
                        console.error(`${opts.logPrefix} Client write error (client disconnected):`, e);
                        failedCode = FailedCode.CLIENT_DISCONNECTED;
                        clientDisconnected = true;
                        break;
                    }
                }

                if (clientDisconnected) break;
            }

            if (clientDisconnected) break;
        }
    } catch (e: any) {
        console.error(`${opts.logPrefix} Unexpected stream error:`, e);
        if (failedCode !== FailedCode.CLIENT_DISCONNECTED) {
            failedCode = FailedCode.UPSTREAM_DISCONNECTED;
        }
    }

    c.req.raw.signal.removeEventListener("abort", abortHandler);
    return { accumulator, firstTokenTime, failedCode, streamErrorData, eventCount };
}


/**
 * 流式收尾（后台执行）：完成 → 记成功 + 扣费；中断 / 上游错误 / 流不完整 → 记 FAILED。
 * 成功分支统一按 OpenAI 口径解析 accumulator 输出的规范化 usage（三个 accumulator 已统一键）。
 */
function finalizeStreamResult(
    c: Context,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    state: StreamRunResult,
): void {
    const { accumulator, firstTokenTime, failedCode, streamErrorData } = state;

    runInBackground(c, async () => {
        // 响应已完整接收（[DONE] / message_stop / response.completed）时优先视为成功：
        // 即使随后客户端或上游连接断开，也可能只是客户端拿到完整结果后提前关闭了连接
        if (accumulator.isCompleted()) {
            const fullResponse = accumulator.getResponse();
            const normalizedUsage = usageUtils.normalizeUsage(ApiFormat.OPENAI, accumulator.getUsage() as Dict | null);
            const usageJson = usageUtils.serializeStoredUsage(normalizedUsage?.recordUsage ?? null);
            const cost = normalizedUsage
                ? usageUtils.calculateCost(model, normalizedUsage.promptTokens, normalizedUsage.outputTokens, normalizedUsage.cacheReadTokens)
                : 0;

            await recordService.update(record.id, {
                response_data: JSON.stringify(fullResponse),
                status: SgRecordStatus.SUCCESS,
                usage: usageJson,
                first_token_latency: firstTokenTime !== null
                    ? firstTokenTime - record.created_at.getTime()
                    : null,
                end_at: new Date(),
                cost,
            });
            await requestActivityService.append(record.id, RequestActivityStage.RESULT, "请求成功", {
                status: SgRecordStatus.SUCCESS,
                cost,
            });

            if (user.type !== "root") {
                await userService.deductBalance(user.id, cost);
            }
            return;
        }

        if (
            failedCode === FailedCode.CLIENT_DISCONNECTED
            || failedCode === FailedCode.UPSTREAM_DISCONNECTED
        ) {
            await recordService.update(record.id, {
                status: SgRecordStatus.FAILED,
                failed_code: failedCode,
                end_at: new Date(),
            });
            await requestActivityService.append(record.id, RequestActivityStage.RESULT, "请求中断", {
                status: SgRecordStatus.FAILED,
                failed_code: failedCode,
            }, ActivityLevel.WARN);
            return;
        }

        if (failedCode === FailedCode.UPSTREAM_ERROR || accumulator.isErrored()) {
            const errorData = accumulator.getError() ?? streamErrorData;
            await recordService.update(record.id, {
                status: SgRecordStatus.FAILED,
                failed_code: FailedCode.UPSTREAM_ERROR,
                response_data: errorData !== null && typeof errorData !== "string"
                    ? JSON.stringify(errorData) : null,
                end_at: new Date(),
            });
            await requestActivityService.append(record.id, RequestActivityStage.RESULT, "上游返回错误", {
                status: SgRecordStatus.FAILED,
                failed_code: FailedCode.UPSTREAM_ERROR,
            }, ActivityLevel.ERROR);
            return;
        }

        await recordService.update(record.id, {
            status: SgRecordStatus.FAILED,
            failed_code: FailedCode.STREAM_INCOMPLETE,
            end_at: new Date(),
        });
        await requestActivityService.append(record.id, RequestActivityStage.RESULT, "流式响应不完整", {
            status: SgRecordStatus.FAILED,
            failed_code: FailedCode.STREAM_INCOMPLETE,
        }, ActivityLevel.WARN);
    });
}


// ====================================================================
// 公开入口
// ====================================================================

/**
 * 非流式响应：各协议通用。协议转换按 converter 是否存在判断，上游 usage 按 upstreamFormat 解析。
 */
export async function handleNonStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    upstreamFormat: ApiFormat,
    converter: BaseConverter | null = null,
): Promise<Response> {
    const responseText = await upstreamRes.text();
    const statusCode = upstreamRes.status as StatusCode;

    if (!upstreamRes.ok) {
        console.error("[responseHandlerService] Upstream non-stream error response:", {
            recordId: record.id,
            status: statusCode,
            contentType: upstreamRes.headers.get("content-type"),
            body: responseText,
        });

        // 非流式：首 token 时间 = 整体响应耗时
        await recordService.update(record.id, {
            response_data: responseText,
            status: SgRecordStatus.FAILED,
            usage: null,
            end_at: new Date(),
            cost: 0,
            first_token_latency: Date.now() - record.created_at.getTime(),
        });
        await requestActivityService.append(record.id, RequestActivityStage.RESULT, "上游返回非成功响应", {
            status: SgRecordStatus.FAILED,
            upstream_status: statusCode,
            response_body: responseText,
        }, ActivityLevel.ERROR);

        c.status(statusCode);
        c.res.headers.set("Content-Type", upstreamRes.headers.get("content-type") || "application/json");
        return c.body(responseText);
    }

    let clientResponseText = responseText;
    if (converter) {
        try {
            const responseJson = JSON.parse(responseText);
            const clientRes = converter.convertResponse(responseJson);
            clientResponseText = JSON.stringify(clientRes);
        } catch (e) {
            console.error("[responseHandlerService] Failed to convert response format:", e);
            throw new customError.AppError(
                `Failed to convert upstream response format: ${e instanceof Error ? e.message : String(e)}`,
                502,
            );
        }
    }

    let normalizedUsage: ReturnType<typeof usageUtils.normalizeUsage> | null = null;
    try {
        const responseJson = JSON.parse(responseText);
        normalizedUsage = usageUtils.normalizeUsage(upstreamFormat, responseJson.usage);
    } catch (e) {
        console.log("Failed to parse response for token stats:", e);
    }

    const usageJson = normalizedUsage ? usageUtils.serializeStoredUsage(normalizedUsage.recordUsage) : null;
    const cost = normalizedUsage
        ? usageUtils.calculateCost(model, normalizedUsage.promptTokens, normalizedUsage.outputTokens, normalizedUsage.cacheReadTokens)
        : 0;

    const recordStatus = statusCode === 200 ? SgRecordStatus.SUCCESS : SgRecordStatus.FAILED;
    // 非流式：首 token 时间 = 整体响应耗时
    const endedAt = Date.now();
    await recordService.update(record.id, {
        response_data: clientResponseText,
        status: recordStatus,
        usage: usageJson,
        end_at: new Date(endedAt),
        cost: cost,
        first_token_latency: endedAt - record.created_at.getTime(),
    });
    await requestActivityService.append(record.id, RequestActivityStage.RESULT,
        recordStatus === SgRecordStatus.SUCCESS ? "请求成功" : "请求失败",
        {
            status: recordStatus,
            upstream_status: statusCode,
            ...(recordStatus === SgRecordStatus.SUCCESS ? { cost } : {}),
        },
        recordStatus === SgRecordStatus.SUCCESS ? ActivityLevel.INFO : ActivityLevel.ERROR,
    );

    if (user.type !== "root" && statusCode === 200) {
        await userService.deductBalance(user.id, cost);
    }

    c.status(statusCode);
    c.header("Content-Type", "application/json");
    return c.body(clientResponseText);
}


/**
 * 流式响应：按客户端协议格式选择累加器（anthropic / responses / openai chat）。
 */
export async function handleStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    format: ApiFormat,
    upstreamFormat: ApiFormat = format,
    converter: BaseConverter | null = null,
): Promise<Response> {
    const logStream = await streamLogService.prepareStreamLog(record);

    let accumulator: AccumulatorBase;
    if (format === ApiFormat.ANTHROPIC) {
        accumulator = new anthropicAccumulator.AnthropicAccumulator();
    } else if (format === ApiFormat.RESPONSES) {
        accumulator = new responsesAccumulator.ResponsesAccumulator();
    } else {
        accumulator = new openaiChatAccumulator.OpenAIChatAccumulator();
    }

    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const state = await runSseLoop(c, upstreamRes, stream, logStream, {
            accumulator,
            converter,
            logPrefix: "[responseHandlerService]",
        });
        console.log(`[responseHandlerService] Stream ended, events: ${state.eventCount}, completed: ${state.accumulator.isCompleted()}, failedCode: ${state.failedCode}`);
        finalizeStreamResult(c, record, model, user, state);
        logStream?.end();
    });
}


export default {
    handleStreamResponse,
    handleNonStreamResponse,
};