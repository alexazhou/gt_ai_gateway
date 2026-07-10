import { Context } from "hono";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import { StatusCode } from "hono/utils/http-status";
import { SgModel } from "../model/sgModel";
import { SgUser } from "../model/sgUser";
import { SgRecord } from "../model/sgRecord";
import { ApiFormat, FailedCode, SgRecordStatus } from "../constants";
import { BaseConverter } from "../util/protocolConverter/BaseConverter";
import { ProtocolStreamEvent } from "../util/protocolConverter/protocolTypes";
import recordService from "./recordService";
import userService from "./userService";
import streamLogService from "./streamLogService";
import usageUtils, { type Dict } from "../util/usageUtils";
import openaiChatAccumulator from "../util/accumulator/openaiChatAccumulator";
import anthropicMessagesAccumulator from "../util/accumulator/anthropicMessagesAccumulator";
import responsesAccumulator from "../util/accumulator/responsesAccumulator";
import sseEvent from "../util/sseEvent";
import { runInBackground } from "../util/runInBackground";
import customError from "../util/customError";

export async function handleChatStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    format: ApiFormat,
    upstreamFormat: ApiFormat = format,
    converter: BaseConverter | null = null,
): Promise<Response> {
    const needsConversion = format !== upstreamFormat;
    const accumulator = format === ApiFormat.ANTHROPIC
        ? new anthropicMessagesAccumulator.AnthropicMessagesAccumulator()
        : new openaiChatAccumulator.OpenAIChatAccumulator();

    let firstTokenTime: number | null = null;

    const logStream = await streamLogService.prepareStreamLog(record);

    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const reader = upstreamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventCount = 0;
        let failedCode: string | null = null;
        let streamErrorData: unknown | null = null;

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
                    console.error("[responseHandlerService] Upstream read error:", e);
                    if (!failedCode) failedCode = FailedCode.UPSTREAM_DISCONNECTED;
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

                    const clientEvents = needsConversion && converter
                        ? converter.convertStreamEvent(parsedEvent.data, parsedEvent.event, parsedEvent.id)
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
                            console.error("[responseHandlerService] Client write error (client disconnected):", e);
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
            console.error("[responseHandlerService] Unexpected stream error:", e);
            if (!failedCode) {
                failedCode = FailedCode.UPSTREAM_DISCONNECTED;
            }
        }

        c.req.raw.signal.removeEventListener("abort", abortHandler);

        console.log(`[responseHandlerService] Stream ended, events: ${eventCount}, completed: ${accumulator.isCompleted()}, failedCode: ${failedCode}`);

        runInBackground(c, async () => {
            // 响应已完整接收（[DONE] / message_stop）时优先视为成功：
            // 即使随后客户端或上游连接断开，也可能只是客户端拿到完整结果后提前关闭了连接
            if (accumulator.isCompleted()) {
                const fullResponse = accumulator.getResponse();
                const usage = accumulator.getUsage();
                const usageAccounting = usageUtils.buildStreamUsageAccounting(format, usage, model);

                await recordService.update(record.id, {
                    response_data: JSON.stringify(fullResponse),
                    status: SgRecordStatus.SUCCESS,
                    usage: usageAccounting.usageJson,
                    first_token_latency: firstTokenTime !== null
                        ? firstTokenTime - record.created_at.getTime()
                        : null,
                    end_at: new Date(),
                    cost: usageAccounting.cost,
                });

                if (user.type !== "root") {
                    await userService.deductBalance(user.id, usageAccounting.cost);
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
                return;
            }

            await recordService.update(record.id, {
                status: SgRecordStatus.FAILED,
                failed_code: FailedCode.STREAM_INCOMPLETE,
                end_at: new Date(),
            });
        });

        logStream?.end();
    });
}

export async function handleChatNonStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    format: ApiFormat,
    upstreamFormat: ApiFormat = format,
    converter: BaseConverter | null = null,
): Promise<Response> {
    const responseText = await upstreamRes.text();
    const statusCode = upstreamRes.status as StatusCode;
    const needsConversion = format !== upstreamFormat;

    if (!upstreamRes.ok) {
        console.error("[responseHandlerService] Upstream non-stream error response:", {
            recordId: record.id,
            status: statusCode,
            contentType: upstreamRes.headers.get("content-type"),
            body: responseText,
        });

        await recordService.update(record.id, {
            response_data: responseText,
            status: SgRecordStatus.FAILED,
            usage: null,
            end_at: new Date(),
            cost: 0,
        });

        c.status(statusCode);
        c.res.headers.set("Content-Type", upstreamRes.headers.get("content-type") || "application/json");
        return c.body(responseText);
    }

    let clientResponseText = responseText;
    if (needsConversion && converter) {
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

    const usageJson = normalizedUsage ? JSON.stringify(normalizedUsage.recordUsage) : null;
    const cost = normalizedUsage
        ? usageUtils.calculateCost(model, normalizedUsage.promptTokens, normalizedUsage.outputTokens, normalizedUsage.cacheReadTokens)
        : 0;

    await recordService.update(record.id, {
        response_data: clientResponseText,
        status: statusCode === 200 ? SgRecordStatus.SUCCESS : SgRecordStatus.FAILED,
        usage: usageJson,
        end_at: new Date(),
        cost: cost,
    });

    if (user.type !== "root" && statusCode === 200) {
        await userService.deductBalance(user.id, cost);
    }

    c.status(statusCode);
    c.res.headers.set("Content-Type", "application/json");
    return c.text(clientResponseText);
}

export async function handleResponsesStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    converter: BaseConverter | null = null,
    upstreamFormat: ApiFormat = ApiFormat.RESPONSES,
): Promise<Response> {
    let firstTokenTime: number | null = null;
    const logStream = await streamLogService.prepareStreamLog(record);
    const needsConversion = converter !== null;

    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const accumulator = new responsesAccumulator.ResponsesAccumulator();
        const reader = upstreamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let failedCode: string | null = null;
        let streamErrorData: unknown | null = null;

        const abortHandler = () => {
            failedCode = FailedCode.CLIENT_DISCONNECTED;
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
                    console.error("[responseHandlerService] Upstream read error (responses):", e);
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

                    const parsedEvent = sseEvent.parseEvent(event);
                    if (!parsedEvent) continue;

                    let clientEvents: ProtocolStreamEvent[];
                    if (needsConversion && converter) {
                        clientEvents = converter.convertStreamEvent(parsedEvent.data, parsedEvent.event, parsedEvent.id);
                    } else {
                        clientEvents = [parsedEvent];
                    }

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
                            console.error("[responseHandlerService] Client write error (client disconnected, responses):", e);
                            failedCode = FailedCode.CLIENT_DISCONNECTED;
                            clientDisconnected = true;
                            break;
                        }
                    }
                }

                if (clientDisconnected) break;
            }
        } catch (e: any) {
            console.error("[responseHandlerService] Unexpected stream error (responses):", e);
            if (failedCode !== FailedCode.CLIENT_DISCONNECTED) {
                failedCode = FailedCode.UPSTREAM_DISCONNECTED;
            }
        }

        c.req.raw.signal.removeEventListener("abort", abortHandler);

        runInBackground(c, async () => {
            // 响应已完整接收（收到 response.completed）时优先视为成功：
            // 即使随后客户端或上游连接断开，也可能只是客户端拿到完整结果后提前关闭了连接
            if (accumulator.isCompleted()) {
                const fullResponse = accumulator.getResponse();
                const usage = accumulator.getUsage() as Dict | null;
                const normalizedUsage = usageUtils.normalizeUsage(ApiFormat.RESPONSES, usage);
                const cost = normalizedUsage
                    ? usageUtils.calculateCost(model, normalizedUsage.promptTokens, normalizedUsage.outputTokens, normalizedUsage.cacheReadTokens)
                    : 0;
                const usageJson = normalizedUsage ? JSON.stringify(normalizedUsage.recordUsage) : null;

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
                return;
            }

            if (failedCode === FailedCode.UPSTREAM_ERROR || accumulator.isErrored()) {
                const errorData = accumulator.getError() ?? streamErrorData;
                await recordService.update(record.id, {
                    status: SgRecordStatus.FAILED,
                    failed_code: FailedCode.UPSTREAM_ERROR,
                    response_data: errorData !== null ? JSON.stringify(errorData) : null,
                    end_at: new Date(),
                });
                return;
            }

            await recordService.update(record.id, {
                status: SgRecordStatus.FAILED,
                failed_code: FailedCode.STREAM_INCOMPLETE,
                end_at: new Date(),
            });
        });

        logStream?.end();
    });
}

export async function handleResponsesNonStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    converter: BaseConverter | null = null,
    upstreamFormat: ApiFormat = ApiFormat.RESPONSES,
): Promise<Response> {
    const responseText = await upstreamRes.text();
    const statusCode = upstreamRes.status as StatusCode;
    const needsConversion = converter !== null;

    if (!upstreamRes.ok) {
        console.error("[responseHandlerService] Upstream responses non-stream error response:", {
            recordId: record.id,
            status: statusCode,
            contentType: upstreamRes.headers.get("content-type"),
            body: responseText,
        });

        await recordService.update(record.id, {
            response_data: responseText,
            status: SgRecordStatus.FAILED,
            usage: null,
            end_at: new Date(),
            cost: 0,
        });

        c.status(statusCode);
        c.res.headers.set("Content-Type", upstreamRes.headers.get("content-type") || "application/json");
        return c.body(responseText);
    }

    let clientResponseText = responseText;
    if (needsConversion && converter) {
        try {
            const responseJson = JSON.parse(responseText);
            const clientRes = converter.convertResponse(responseJson);
            clientResponseText = JSON.stringify(clientRes);
        } catch (e) {
            console.error("[responseHandlerService] Failed to convert responses non-stream response:", e);
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
        console.log("Failed to parse responses API response:", e);
    }

    const usageJson = normalizedUsage ? JSON.stringify(normalizedUsage.recordUsage) : null;
    const cost = normalizedUsage
        ? usageUtils.calculateCost(model, normalizedUsage.promptTokens, normalizedUsage.outputTokens, normalizedUsage.cacheReadTokens)
        : 0;

    await recordService.update(record.id, {
        response_data: clientResponseText,
        status: statusCode === 200 ? SgRecordStatus.SUCCESS : SgRecordStatus.FAILED,
        usage: usageJson,
        end_at: new Date(),
        cost,
    });

    if (user.type !== "root" && statusCode === 200) {
        await userService.deductBalance(user.id, cost);
    }

    c.status(statusCode);
    c.res.headers.set("Content-Type", "application/json");
    return c.text(clientResponseText);
}

export default {
    handleChatStreamResponse,
    handleChatNonStreamResponse,
    handleResponsesStreamResponse,
    handleResponsesNonStreamResponse,
};
