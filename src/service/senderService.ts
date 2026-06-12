import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { StatusCode } from "hono/dist/types/utils/http-status";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import { SgUser } from "../model/sgUser";
import { SgVendor } from "../model/sgVendor";
import { SgVendorModel } from "../model/sgVendorModel";
import recordService from "./recordService";
import ormService from "./ormService";
import { SgRecordStatus, FailedCode, ApiFormat } from "../constants";
import sseAccumulator from "../util/sseAccumulator";
import { SgRecord, SgRecordUsage } from "../model/sgRecord";
import { mkdirSync, existsSync, createWriteStream, WriteStream } from "fs";
import { join } from "path";
import { getLogDir } from "../util/logger";
import userService from "./userService";
import customError from "../util/customError";
import { ConverterFactory } from "../util/protocolConverter/ConverterFactory";
import type { BaseConverter } from "../util/protocolConverter/BaseConverter";
import sseEvent from "../util/sseEvent";


// Calculate cost based on model pricing and token usage
function calculateCost(
    model: SgModel,
    promptTokens: number,
    outputTokens: number,
): number {
    const promptCost = (promptTokens / 1000) * model.input_price;
    const outputCost = (outputTokens / 1000) * model.output_price;
    return promptCost + outputCost;
}


function prepareStreamLog(record: SgRecord): WriteStream | null {
    const isStreamLogEnabled = ormService.isNode && process.env.STREAM_LOG_ENABLED === "true";

    if (!isStreamLogEnabled) {
        return null;
    }

    const baseLogDir = getLogDir();
    const logDir = join(baseLogDir, "stream");
    console.log("[senderService] Stream log enabled, dir:", logDir);

    if (!existsSync(logDir)) {
        console.log("[senderService] Creating log dir...");
        try {
            mkdirSync(logDir, { recursive: true });
        } catch (e: any) {
            console.log("[senderService] Failed to create log dir:", e);
            return null;
        }
    }

    const logFilePath = join(logDir, `${record.id}.log`);
    console.log("[senderService] Stream log file path:", logFilePath);
    
    return createWriteStream(logFilePath, { flags: "a" });
}


function appendStreamLog(logStream: WriteStream | null, chunk: string): void {
    if (!logStream) {
        return;
    }

    console.log(
        "[senderService] Chunk length:",
        chunk.length,
        "contains \\n:",
        chunk.includes("\n"),
        "contains \\n\\n:",
        chunk.includes("\n\n"),
    );

    logStream.write(chunk);
}


async function handleStreamResponse(
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
    const accumulator = new sseAccumulator.SSEAccumulator(
        format === ApiFormat.ANTHROPIC ? "anthropic" : "openai",
    );

    let firstTokenTime: number | null = null;

    const logStream = prepareStreamLog(record);

    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const reader = upstreamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventCount = 0;
        let streamCompleted = false;
        let failedCode: string | null = null;

        try {
            // 逐块读取上游 SSE 字节流
            while (true) {
                let done: boolean;
                let value: Uint8Array | undefined;
                try {
                    const result = await reader.read();
                    done = result.done;
                    value = result.value;
                } catch (e: any) {
                    console.error("[senderService] Upstream read error:", e);
                    failedCode = FailedCode.UPSTREAM_DISCONNECTED;
                    break;
                }
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                appendStreamLog(logStream, chunk);
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

                        const isCompleted = sseEvent.isClientStreamCompleted(format, clientEvent);
                        if (firstTokenTime === null && !isCompleted) {
                            firstTokenTime = Date.now();
                        }

                        if (isCompleted) {
                            streamCompleted = true;
                        }

                        try {
                            await stream.writeSSE({
                                data: clientEvent.data,
                                event: clientEvent.event,
                                id: clientEvent.id,
                            });
                        } catch (e: any) {
                            console.error("[senderService] Client write error (client disconnected):", e);
                            failedCode = FailedCode.CLIENT_DISCONNECTED;
                            clientDisconnected = true;
                            break;
                        }

                        if (isCompleted) continue;

                        try {
                            const parsedData = JSON.parse(clientEvent.data);
                            accumulator.addMessage(parsedData, clientEvent.event);
                        } catch (e) {
                            console.log("Failed to parse SSE data:", clientEvent.data, e);
                        }
                    }

                    if (clientDisconnected) break;
                }

                if (clientDisconnected) break;
            }
        } catch (e: any) {
            console.error("[senderService] Unexpected stream error:", e);
            if (!failedCode) {
                failedCode = FailedCode.UPSTREAM_DISCONNECTED;
            }
        }

        console.log(`[senderService] Stream ended, events: ${eventCount}, completed: ${streamCompleted}, failedCode: ${failedCode}`);

        if (streamCompleted) {
            // 流结束，保存完整响应到数据库
            const fullResponse = accumulator.getResponse();
            const promptTokens = fullResponse.usage?.prompt_tokens ?? 0;
            const outputTokens = fullResponse.usage?.completion_tokens ?? 0;
            const cost = calculateCost(model, promptTokens, outputTokens);

            await recordService.update(record.id, {
                response_data: JSON.stringify(fullResponse),
                status: SgRecordStatus.SUCCESS,
                usage: fullResponse.usage ? JSON.stringify(fullResponse.usage) : null,
                first_token_latency: firstTokenTime !== null
                    ? firstTokenTime - record.created_at.getTime()
                    : null,
                end_at: new Date(),
                cost: cost,
            });

            // 扣除用户余额（仅非 Root 用户）
            if (user.type !== "root") {
                await userService.deductBalance(user.id, cost);
            }
        } else {
            await recordService.update(record.id, {
                status: SgRecordStatus.FAILED,
                failed_code: failedCode ?? FailedCode.STREAM_INCOMPLETE,
                end_at: new Date(),
            });
        }

        logStream?.end();
    });
}


async function handleNonStreamResponse(
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

    let clientResponseText = responseText;
    if (needsConversion && converter) {
        try {
            const responseJson = JSON.parse(responseText);
            const clientRes = converter.convertResponse(responseJson);
            clientResponseText = JSON.stringify(clientRes);
        } catch (e) {
            console.error("[senderService] Failed to convert response format:", e);
        }
    }

    // 从响应体中提取 token 统计
    let promptTokens: number | null = null;
    let outputTokens: number | null = null;
    let usageJson: string | null = null;
    try {
        const responseJson = JSON.parse(responseText);
        if (upstreamFormat === ApiFormat.ANTHROPIC) {
            promptTokens = responseJson.usage?.input_tokens ?? null;
            outputTokens = responseJson.usage?.output_tokens ?? null;
            if (responseJson.usage) {
                const u = new SgRecordUsage();
                u.prompt_tokens = promptTokens ?? undefined;
                u.completion_tokens = outputTokens ?? undefined;
                u.cache_read_tokens = responseJson.usage.cache_read_input_tokens ?? undefined;
                u.cache_creation_tokens = responseJson.usage.cache_creation_input_tokens ?? undefined;
                usageJson = JSON.stringify(u);
            }
        } else {
            promptTokens = responseJson.usage?.prompt_tokens ?? null;
            outputTokens = responseJson.usage?.completion_tokens ?? null;
            if (responseJson.usage) {
                const u = new SgRecordUsage();
                u.prompt_tokens = promptTokens ?? undefined;
                u.completion_tokens = outputTokens ?? undefined;
                u.cache_read_tokens = responseJson.usage.prompt_tokens_details?.cached_tokens ?? undefined;
                usageJson = JSON.stringify(u);
            }
        }
    } catch (e) {
        console.log("Failed to parse response for token stats:", e);
    }

    const finalPromptTokens = promptTokens ?? 0;
    const finalOutputTokens = outputTokens ?? 0;
    const cost = calculateCost(model, finalPromptTokens, finalOutputTokens);

    await recordService.update(record.id, {
        response_data: clientResponseText,
        status: statusCode === 200 ? SgRecordStatus.SUCCESS : SgRecordStatus.FAILED,
        usage: usageJson,
        end_at: new Date(),
        cost: cost,
    });

    // 扣除用户余额（仅非 Root 用户且请求成功）
    if (user.type !== "root" && statusCode === 200) {
        await userService.deductBalance(user.id, cost);
    }

    c.status(statusCode);
    c.res.headers.set("Content-Type", "application/json");
    return c.text(clientResponseText);
}


async function handleResponsesStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
): Promise<Response> {
    let firstTokenTime: number | null = null;
    const logStream = prepareStreamLog(record);

    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const reader = upstreamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamCompleted = false;
        let failedCode: string | null = null;

        try {
            while (true) {
                let done: boolean;
                let value: Uint8Array | undefined;
                try {
                    const result = await reader.read();
                    done = result.done;
                    value = result.value;
                } catch (e: any) {
                    console.error("[senderService] Upstream read error (responses):", e);
                    failedCode = FailedCode.UPSTREAM_DISCONNECTED;
                    break;
                }
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                appendStreamLog(logStream, chunk);
                buffer += chunk;

                const splitResult = sseEvent.splitEvents(buffer);
                const events = splitResult.events;
                buffer = splitResult.remainingBuffer;

                let clientDisconnected = false;
                for (const event of events) {
                    if (!event.trim()) continue;

                    const parsedEvent = sseEvent.parseEvent(event);
                    if (!parsedEvent) continue;

                    // Responses API embeds event type in the JSON `type` field (no SSE `event:` line)
                    let parsedData: any = null;
                    try {
                        parsedData = JSON.parse(parsedEvent.data);
                    } catch (e) {
                        // ignore unparseable lines
                    }

                    const eventType = parsedEvent.event ?? "";
                    const responseEventType = parsedData?.type ?? eventType;

                    if (firstTokenTime === null && responseEventType === "response.output_text.delta") {
                        firstTokenTime = Date.now();
                    }

                    // response.completed 表示上游已完成，在转发前标记
                    if (responseEventType === "response.completed" && parsedData) {
                        streamCompleted = true;
                    }

                    try {
                        await stream.writeSSE({
                            data: parsedEvent.data,
                            event: parsedEvent.event,
                            id: parsedEvent.id,
                        });
                    } catch (e: any) {
                        console.error("[senderService] Client write error (client disconnected, responses):", e);
                        failedCode = FailedCode.CLIENT_DISCONNECTED;
                        clientDisconnected = true;
                        break;
                    }

                    // response.completed 包含完整 usage，保存记录
                    if (responseEventType === "response.completed" && parsedData) {
                        try {
                            const usage = parsedData?.response?.usage;
                            const promptTokens = usage?.input_tokens ?? 0;
                            const outputTokens = usage?.output_tokens ?? 0;
                            const cost = calculateCost(model, promptTokens, outputTokens);
                            let usageJson: string | null = null;
                            if (usage) {
                                const u = new SgRecordUsage();
                                u.prompt_tokens = promptTokens;
                                u.completion_tokens = outputTokens;
                                usageJson = JSON.stringify(u);
                            }

                            await recordService.update(record.id, {
                                response_data: JSON.stringify(parsedData.response),
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
                        } catch (e) {
                            console.log("Failed to update record on response.completed:", e);
                        }
                    }
                }

                if (clientDisconnected) break;
            }
        } catch (e: any) {
            console.error("[senderService] Unexpected stream error (responses):", e);
            if (!failedCode) {
                failedCode = FailedCode.UPSTREAM_DISCONNECTED;
            }
        }

        if (!streamCompleted) {
            await recordService.update(record.id, {
                status: SgRecordStatus.FAILED,
                failed_code: failedCode ?? FailedCode.STREAM_INCOMPLETE,
                end_at: new Date(),
            });
        }

        logStream?.end();
    });
}


async function handleResponsesNonStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
): Promise<Response> {
    const responseText = await upstreamRes.text();
    const statusCode = upstreamRes.status as StatusCode;

    let promptTokens = 0;
    let outputTokens = 0;
    let usageJson: string | null = null;
    try {
        const responseJson = JSON.parse(responseText);
        promptTokens = responseJson.usage?.input_tokens ?? 0;
        outputTokens = responseJson.usage?.output_tokens ?? 0;
        if (responseJson.usage) {
            const u = new SgRecordUsage();
            u.prompt_tokens = promptTokens;
            u.completion_tokens = outputTokens;
            usageJson = JSON.stringify(u);
        }
    } catch (e) {
        console.log("Failed to parse responses API response:", e);
    }

    const cost = calculateCost(model, promptTokens, outputTokens);

    await recordService.update(record.id, {
        response_data: responseText,
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
    return c.text(responseText);
}


async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    vendor: SgVendor,
    format: ApiFormat,
    body: string,
): Promise<Response> {
    const upstreamFormat = vendor.getUpstreamFormat(format);
    const needsConversion = format !== upstreamFormat;

    const url = vendor.getUrlByFormat(upstreamFormat);

    console.log("sendRequest: modelConfig={}, format={}, upstreamFormat={}", modelConfig, format, upstreamFormat);

    // Check user balance (only for non-root users)
    if (user.type !== "root") {
        // Estimate max possible cost based on model pricing
        // We'll allow the request and deduct actual cost after completion
        console.log(`[senderService] Checking balance for user ${user.id}: ${user.balance}`);
    }

    // 1. 创建数据库记录
    const record = await recordService.create(user.id, modelConfig.id, body, format, upstreamFormat);
    await recordService.update(record.id, {
        status: SgRecordStatus.PROCESSING,
        start_at: new Date(),
    });

    // 2. 构建上游请求 headers，过滤掉 Cloudflare 注入的 cf- 前缀 header
    // 并且必须排除客户端自带的鉴权 header，避免泄露或导致合并错误
    // 同时排除浏览器相关的元数据 header，避免上游校验失败
    const finalHeaders = new Headers();
    const EXCLUDED_HEADERS = [
        "authorization",
        "x-api-key",
        "anthropic-version",
        "content-length",
        "host",
        "origin",
        "referer",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ];

    for (const [key, value] of c.req.raw.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (
            !lowerKey.startsWith("cf-") &&
            !lowerKey.startsWith("sec-") && // 排除浏览器 Sec-Headers
            !EXCLUDED_HEADERS.includes(lowerKey)
        ) {
            finalHeaders.set(key, value);
        }
    }

    if (upstreamFormat === ApiFormat.ANTHROPIC) {
        finalHeaders.set("x-api-key", vendor.token);
        finalHeaders.set("anthropic-version", "2023-06-01");
    } else {
        finalHeaders.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
    }

    // 强制设置 content-type
    finalHeaders.set("Content-Type", "application/json");

    // 3. 替换上游模型名：若 model 配置了 vendor_model_id，用对应的 vendor_model.model_id 替换请求体中的 model 字段
    let upstreamBody = body;
    if (modelConfig.vendor_model_id) {
        const vendorModel = await SgVendorModel.query().find(modelConfig.vendor_model_id);
        if (vendorModel) {
            try {
                const bodyJson = JSON.parse(upstreamBody);
                bodyJson.model = vendorModel.model_id;
                upstreamBody = JSON.stringify(bodyJson);
            } catch (e) {
                console.log("[senderService] Failed to substitute model name:", e);
            }
        }
    }

    // 4. 请求体改写：将 system 中 x-anthropic-billing-header 的 cch 值固定为 A1234
    try {
        const bodyJson = JSON.parse(upstreamBody);
        if (typeof bodyJson.system === "string" && bodyJson.system.includes("cch=")) {
            bodyJson.system = bodyJson.system.replace(/(cch=)[^;]*(;)/, "$1A1234$2");
            upstreamBody = JSON.stringify(bodyJson);
        } else if (Array.isArray(bodyJson.system)) {
            for (const block of bodyJson.system) {
                if (block.type === "text" && typeof block.text === "string" && block.text.includes("cch=")) {
                    block.text = block.text.replace(/(cch=)[^;]*(;)/, "$1A1234$2");
                }
            }
            upstreamBody = JSON.stringify(bodyJson);
        }
    } catch (e) {
        console.log("[senderService] Failed to rewrite cch:", e);
    }

    let converter: BaseConverter | null = null;
    if (needsConversion) {
        if (format === ApiFormat.RESPONSES || upstreamFormat === ApiFormat.RESPONSES) {
            throw new customError.AppError(
                `Protocol conversion is not supported for Responses API format`,
                400,
            );
        }

        converter = ConverterFactory.createPair(format, upstreamFormat);
        if (!converter) {
            throw new customError.AppError(
                `Unsupported protocol conversion: ${format} → ${upstreamFormat}`,
                400,
            );
        }
        console.log(`[senderService] Using protocol converter: ${converter.constructor.name}, client=${format}, upstream=${upstreamFormat}`);
        upstreamBody = converter.convertRequestBody(upstreamBody);
    }

    let requestModel = "unknown";
    try {
        const parsedBody = JSON.parse(upstreamBody);
        requestModel = parsedBody.model || "unknown";
    } catch (e) {}
    converter?.updateModel(requestModel);

    // 4. OpenAI 流式请求注入 stream_options，让上游在最后一帧返回 usage
    if (upstreamFormat === ApiFormat.OPENAI) {
        try {
            const bodyJson = JSON.parse(upstreamBody);
            if (bodyJson.stream === true) {
                bodyJson.stream_options = { include_usage: true };
                upstreamBody = JSON.stringify(bodyJson);
            }
        } catch (e) {
            console.log("Failed to inject stream_options:", e);
        }
    }

    // 4. 发起上游请求，拿到响应头后立即判断响应类型
    let upstreamRes: Response;
    try {
        upstreamRes = await fetch(url, { method: "POST", headers: finalHeaders, body: upstreamBody });
    } catch (e: any) {
        console.error("Upstream fetch failed:", e);
        await recordService.update(record.id, {
            status: SgRecordStatus.FAILED,
            response_data: String(e),
            end_at: new Date(),
        });
        throw e;
    }
    console.log("upstream response status:", upstreamRes.status);

    const isStream =
        upstreamRes.ok &&
        upstreamRes.headers.get("content-type")?.startsWith("text/event-stream");

    // 4. 按响应类型分发处理
    if (format === ApiFormat.RESPONSES) {
        if (isStream) {
            return handleResponsesStreamResponse(c, upstreamRes, record, modelConfig, user);
        } else {
            return handleResponsesNonStreamResponse(c, upstreamRes, record, modelConfig, user);
        }
    }

    if (isStream) {
        return handleStreamResponse(c, upstreamRes, record, modelConfig, user, format, upstreamFormat, converter);
    } else {
        return handleNonStreamResponse(c, upstreamRes, record, modelConfig, user, format, upstreamFormat, converter);
    }
}


export default {
    sendRequest,
};
