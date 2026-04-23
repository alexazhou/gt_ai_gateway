import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { StatusCode } from "hono/dist/types/utils/http-status";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import { SgUser } from "../model/sgUser";
import { SgVendor } from "../model/sgVendor";
import recordService from "./recordService";
import ormService from "./ormService";
import { SgRecordStatus, ApiFormat } from "../constants";
import sseAccumulator from "../util/sseAccumulator";
import { SgRecord } from "../model/sgRecord";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getLogDir } from "../util/logger";
import userService from "./userService";
import customError from "../util/customError";


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


async function handleStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    format: ApiFormat,
): Promise<Response> {
    const accumulator = new sseAccumulator.SSEAccumulator(
        format === ApiFormat.ANTHROPIC ? "anthropic" : "openai",
    );
    let firstTokenTime: number | null = null;

    // 检查是否启用流式日志记录（仅本地 Node 模式下可用）
    const isStreamLogEnabled = ormService.isNode && process.env.STREAM_LOG_ENABLED === "true";
    let logFilePath: string | null = null;

    if (isStreamLogEnabled) {
        // 使用统一的日志目录计算方法
        const baseLogDir = getLogDir();
        // 创建流式日志目录
        const logDir = join(baseLogDir, "stream");
        console.log('[senderService] Stream log enabled, dir:', logDir);

        if (!existsSync(logDir)) {
            console.log('[senderService] Creating log dir...');
            try {
                mkdirSync(logDir, { recursive: true });
            } catch (e: any) {
                console.log('[senderService] Failed to create log dir:', e);
            }
        }

        // 创建请求 ID 对应的日志文件
        logFilePath = join(logDir, `${record.id}.log`);
        console.log('[senderService] Stream log file path:', logFilePath);
    }

    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const reader = upstreamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventCount = 0;

        // 逐块读取上游 SSE 字节流
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });

            // 如果启用了流式日志，则写入文件
            if (isStreamLogEnabled && logFilePath) {
                // 调试：打印 chunk 内容
                console.log('[senderService] Chunk length:', chunk.length, 'contains \\n:', chunk.includes('\n'), 'contains \\n\\n:', chunk.includes('\n\n'));

                // 直接写入原始 chunk 到文件
                try {
                    writeFileSync(logFilePath, chunk, { flag: "a" });
                } catch (e: any) {
                    console.log('[senderService] Failed to write to log file:', e);
                }
            }

            buffer += chunk;

            // 按 \n\n 切割出完整的 SSE event
            const events = buffer.split("\n\n");
            // 最后一段可能不完整，留到下一轮拼接
            buffer = events.pop() ?? "";

            for (const event of events) {
                if (!event.trim()) continue;

                eventCount++;

                // 解析 SSE event 中的各字段行（data / event / id / retry）
                const lines = event.split("\n");
                let data = "";
                let eventType = "";
                let id = "";
                for (const line of lines) {
                    if (line.startsWith("data:")) {
                        data = line.slice(5).trim();
                    } else if (line.startsWith("event:")) {
                        eventType = line.slice(6).trim();
                    } else if (line.startsWith("id:")) {
                        id = line.slice(3).trim();
                    }
                }

                if (!data) continue;

                // 记录首个 token 时间
                if (firstTokenTime === null && data !== "[DONE]") {
                    firstTokenTime = Date.now();
                }

                // 转发给客户端
                await stream.writeSSE({ data, event: eventType || undefined, id: id || undefined });

                // [DONE] 之后不需要解析内容
                if (data === "[DONE]") continue;

                // 累积消息用于保存完整响应
                try {
                    const parsedData = JSON.parse(data);
                    accumulator.addMessage(parsedData, eventType);
                } catch (e) {
                    console.log("Failed to parse SSE data:", data, e);
                }
            }
        }

        console.log(`[senderService] Stream ended, total events: ${eventCount}`);

        // 流结束，保存完整响应到数据库
        const fullResponse = accumulator.getResponse();
        const promptTokens = fullResponse.usage?.prompt_tokens ?? 0;
        const outputTokens = fullResponse.usage?.completion_tokens ?? 0;
        const cost = calculateCost(model, promptTokens, outputTokens);

        await recordService.update(record.id, {
            response_data: JSON.stringify(fullResponse),
            status: SgRecordStatus.SUCCESS,
            prompt_tokens: promptTokens,
            output_tokens: outputTokens,
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
    });
}


async function handleNonStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    model: SgModel,
    user: SgUser,
    format: ApiFormat,
): Promise<Response> {
    const responseText = await upstreamRes.text();
    const statusCode = upstreamRes.status as StatusCode;

    // 从响应体中提取 token 统计
    let promptTokens: number | null = null;
    let outputTokens: number | null = null;
    try {
        const responseJson = JSON.parse(responseText);
        if (format === ApiFormat.ANTHROPIC) {
            promptTokens = responseJson.usage?.input_tokens ?? null;
            outputTokens = responseJson.usage?.output_tokens ?? null;
        } else {
            promptTokens = responseJson.usage?.prompt_tokens ?? null;
            outputTokens = responseJson.usage?.completion_tokens ?? null;
        }
    } catch (e) {
        console.log("Failed to parse response for token stats:", e);
    }

    const finalPromptTokens = promptTokens ?? 0;
    const finalOutputTokens = outputTokens ?? 0;
    const cost = calculateCost(model, finalPromptTokens, finalOutputTokens);

    await recordService.update(record.id, {
        response_data: responseText,
        status: statusCode === 200 ? SgRecordStatus.SUCCESS : SgRecordStatus.FAILED,
        prompt_tokens: promptTokens,
        output_tokens: outputTokens,
        end_at: new Date(),
        cost: cost,
    });

    // 扣除用户余额（仅非 Root 用户且请求成功）
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
    const url = vendor.getUrlByFormat(format);

    console.log("sendRequest: modelConfig={}", modelConfig);

    // Check user balance (only for non-root users)
    if (user.type !== "root") {
        // Estimate max possible cost based on model pricing
        // We'll allow the request and deduct actual cost after completion
        console.log(`[senderService] Checking balance for user ${user.id}: ${user.balance}`);
    }

    // 1. 创建数据库记录
    const record = await recordService.create(user.id, modelConfig.id, body);
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

    if (format === ApiFormat.ANTHROPIC) {
        finalHeaders.set("x-api-key", vendor.token);
        finalHeaders.set("anthropic-version", "2023-06-01");
    } else {
        finalHeaders.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
    }

    // 强制设置 content-type
    finalHeaders.set("Content-Type", "application/json");

    // 3. OpenAI 流式请求注入 stream_options，让上游在最后一帧返回 usage
    let upstreamBody = body;
    if (format === ApiFormat.OPENAI) {
        try {
            const bodyJson = JSON.parse(body);
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
    if (isStream) {
        return handleStreamResponse(c, upstreamRes, record, modelConfig, user, format);
    } else {
        return handleNonStreamResponse(c, upstreamRes, record, modelConfig, user, format);
    }
}


export default {
    sendRequest,
};
