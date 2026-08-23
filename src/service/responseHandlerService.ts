import { Context } from "hono";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import { StatusCode } from "hono/utils/http-status";
import type { WriteStream } from "fs";
import { SgModel } from "../model/sgModel";
import { SgUser } from "../model/sgUser";
import { SgRecord } from "../model/sgRecord";
import { ApiFormat, FailedCode, SgRecordStatus, RequestActivityStage, ActivityLevel, ConfigKey } from "../constants";
import { BaseConverter } from "../util/protocolConverter/BaseConverter";
import { AccumulatorBase } from "../util/accumulator/accumulatorBase";
import recordService, { type MarkFailedOptions } from "./recordService";
import requestActivityService from "./requestActivityService";
import configService from "./configService";
import abortTimeoutUtil from "../util/abortTimeoutUtil";
import userService from "./userService";
import streamLogService from "./streamLogService";
import usageUtils, { type Dict } from "../util/protocol/usageUtil";
import openaiChatAccumulator from "../util/accumulator/openaiChatAccumulator";
import anthropicAccumulator from "../util/accumulator/anthropicAccumulator";
import responsesAccumulator from "../util/accumulator/responsesAccumulator";
import sseEventUtil from "../util/protocol/sseEventUtil";
import runInBackgroundUtil from "../util/runInBackgroundUtil";
import customError from "../customError";


// ====================================================================
// 内部类型
// ====================================================================

interface StreamRunResult {
    accumulator: AccumulatorBase;
    firstTokenTime: number | null;
    failedCode: string | null;
    eventCount: number;
}


interface RunSSELoopOptions {
    accumulator: AccumulatorBase;
    converter: BaseConverter | null;
}

// 流式读循环日志前缀（runSSELoop 只被 handleStreamResponse 一处调用，直接固化）
const SSE_LOOP_LOG_PREFIX = "[responseHandlerService]";


// ====================================================================
// 内部方法
// ====================================================================

/**
 * 消费上游 SSE 流：decode → 拆分事件 → 协议转换 → 累加 → 实时转发给客户端。
 * 返回统一状态供收尾使用（finalizeStreamResult）。
 */
async function runSSELoop(
    c: Context,
    upstreamRes: Response,
    stream: SSEStreamingApi,
    logStream: WriteStream | null,
    opts: RunSSELoopOptions,
): Promise<StreamRunResult> {
    const { accumulator } = opts;
    const upstreamReader = upstreamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventCount = 0;
    let failedCode: string | null = null;
    let firstTokenTime: number | null = null;

    // 相邻 chunk 空闲超时：超时置 UPSTREAM_TIMEOUT 并取消上游 body
    const idleTimeoutMs = await configService.getNumber(ConfigKey.UPSTREAM_STREAM_IDLE_TIMEOUT_MS);

    // 客户端断开感知：直接订阅客户端信号，已断开则立即触发
    const unsubscribeClientAbort = abortTimeoutUtil.onSignalAbort(c.req.raw.signal, () => {
        if (!failedCode) failedCode = FailedCode.CLIENT_DISCONNECTED;
        upstreamReader.cancel().catch(() => {});
    });

    try {
        while (true) {
            const result = await abortTimeoutUtil.raceWithTimeout(
                upstreamReader.read(),
                idleTimeoutMs,
                () => {
                    if (!failedCode) failedCode = FailedCode.UPSTREAM_TIMEOUT;
                    upstreamReader.cancel().catch(() => {});
                },
            );
            if (result.done) break;

            const chunk = decoder.decode(result.value, { stream: true });
            streamLogService.appendStreamLog(logStream, chunk);
            buffer += chunk;

            const splitResult = sseEventUtil.splitEvents(buffer);
            const events = splitResult.events;
            buffer = splitResult.remainingBuffer;

            let clientDisconnected = false;
            let parseFailed = false;
            for (const event of events) {
                if (!event.trim()) continue;

                eventCount++;

                const upstreamEvent = sseEventUtil.parseEvent(event);
                if (!upstreamEvent) continue;

                const clientEvents = opts.converter
                    ? opts.converter.convertStreamEvent(upstreamEvent.data, upstreamEvent.event, upstreamEvent.id)
                    : [upstreamEvent];

                for (const clientEvent of clientEvents) {
                    if (!clientEvent.data) continue;

                    accumulator.addEvent(clientEvent);

                    // 解析失败由累加器判定（JSON.parse 失败时置 parseFailed），此处只消费并收尾
                    if (accumulator.isParseFailed()) {
                        if (!failedCode) failedCode = FailedCode.SSE_PARSE_ERROR;
                        parseFailed = true;
                        break;
                    }

                    if (firstTokenTime === null && accumulator.isOutputStarted()) {
                        firstTokenTime = Date.now();
                    }

                    if (accumulator.isErrored()) {
                        // 上游明确返回了错误 → 记上游错误（区别于网关侧解析失败）
                        if (!failedCode) failedCode = FailedCode.UPSTREAM_ERROR;
                    }

                    try {
                        await stream.writeSSE({
                            data: clientEvent.data,
                            event: clientEvent.event,
                            id: clientEvent.id,
                        });
                    } catch (e: any) {
                        console.error(`${SSE_LOOP_LOG_PREFIX} Client write error (client disconnected):`, e);
                        failedCode = FailedCode.CLIENT_DISCONNECTED;
                        clientDisconnected = true;
                        break;
                    }
                }

                if (parseFailed || clientDisconnected) break;
            }

            if (parseFailed || clientDisconnected) break;
        }
    } catch (e: any) {
        // 统一的收尾：空闲超时是预期停顿，跳过日志；其余（客户端断开 / 上游读取错误 /
        // 循环体异常）记日志。失败码秉持「先到先得」：一旦记录就不再覆盖。
        if (failedCode !== FailedCode.UPSTREAM_TIMEOUT) {
            console.error(`${SSE_LOOP_LOG_PREFIX} Stream error:`, e);
        }
        if (!failedCode) failedCode = FailedCode.UPSTREAM_DISCONNECTED;
    }

    unsubscribeClientAbort();
    return { accumulator, firstTokenTime, failedCode, eventCount };
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
    let { accumulator, firstTokenTime, failedCode } = state;

    runInBackgroundUtil.runInBackground(c, async () => {
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

        // 失败收尾：先归一化失败码，再按条件补收尾参数，最后统一写入。
        // ① 未记录失败码（流结束但归因不到具体原因）→ 兜底未知错误
        if (failedCode === null) {
            failedCode = FailedCode.UNKNOWN;
        }

        // ② 上游返回错误 → 附带 error body（默认 null；仅当错误码与累加器判定一致时填充）
        let failedOptions: MarkFailedOptions | null = null;
        if (failedCode === FailedCode.UPSTREAM_ERROR && accumulator.isErrored()) {
            const errorData = accumulator.getError();
            failedOptions = {
                response_data: errorData === null ? null : JSON.stringify(errorData),
            };
        }

        // ③ 统一收尾（null 表示无附加参数，交由 markFailed 默认处理）
        await recordService.markFailed(record.id, failedCode, failedOptions);
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
    // 非流式 body 读取兜底：readTextWithTimeoutAndAbort 一次性处理「上游断开 / 超时 / 客户端断开」，
    // 失败抛 BodyReadError（e.failedCode 即原因），异常时显式把 record 标 FAILED。
    const nonStreamTimeoutMs = await configService.getNumber(ConfigKey.UPSTREAM_NON_STREAM_TIMEOUT_MS);

    let responseText: string;
    try {
        responseText = await abortTimeoutUtil.readTextWithTimeoutAndAbort(upstreamRes, nonStreamTimeoutMs, c.req.raw.signal);
    } catch (e) {
        const failedCode = e instanceof abortTimeoutUtil.BodyReadError
            ? e.failedCode
            : FailedCode.UPSTREAM_DISCONNECTED;
        await recordService.markFailed(record.id, failedCode);
        throw e;
    }

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
        const state = await runSSELoop(c, upstreamRes, stream, logStream, {
            accumulator,
            converter,
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