import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { StatusCode } from "hono/dist/types/utils/http-status";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import { SgUser } from "../model/sgUser";
import { SgVendor } from "../model/sgVendor";
import recordService from "./recordService";
import { SgRecordStatus, ApiFormat } from "../constants";
import sseAccumulator from "../util/sseAccumulator";
import { SgRecord } from "../model/sgRecord";


async function handleStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
    format: ApiFormat,
): Promise<Response> {
    const accumulator = new sseAccumulator.SSEAccumulator(
        format === ApiFormat.ANTHROPIC ? "anthropic" : "openai",
    );
    let firstTokenTime: number | null = null;

    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const reader = upstreamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // 逐块读取上游 SSE 字节流
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // 按 \n\n 切割出完整的 SSE event
            const events = buffer.split("\n\n");
            // 最后一段可能不完整，留到下一轮拼接
            buffer = events.pop() ?? "";

            for (const event of events) {
                if (!event.trim()) continue;

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
                    accumulator.addMessage(JSON.parse(data));
                } catch (e) {
                    console.log("Failed to parse SSE data:", data, e);
                }
            }
        }

        // 流结束，保存完整响应到数据库
        const fullResponse = accumulator.getResponse();
        await recordService.update(record.id, {
            response_data: JSON.stringify(fullResponse),
            status: SgRecordStatus.SUCCESS,
            prompt_tokens: fullResponse.usage?.prompt_tokens ?? null,
            output_tokens: fullResponse.usage?.completion_tokens ?? null,
            first_token_latency: firstTokenTime !== null
                ? firstTokenTime - record.created_at.getTime()
                : null,
            end_at: new Date(),
        });
    });
}


async function handleNonStreamResponse(
    c: Context,
    upstreamRes: Response,
    record: SgRecord,
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

    await recordService.update(record.id, {
        response_data: responseText,
        status: statusCode === 200 ? SgRecordStatus.SUCCESS : SgRecordStatus.FAILED,
        prompt_tokens: promptTokens,
        output_tokens: outputTokens,
        end_at: new Date(),
    });

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
): Promise<Response> {
    const url = vendor.getUrlByFormat(format);

    // 1. 读取请求体，创建数据库记录
    const body: string = await c.req.text();
    const record = await recordService.create(user.id, modelConfig.id, body);
    await recordService.update(record.id, {
        status: SgRecordStatus.PROCESSING,
        start_at: new Date(),
    });

    console.log("sendRequest: modelConfig={}", modelConfig);

    // 2. 构建上游请求 headers，过滤掉 Cloudflare 注入的 cf- 前缀 header
    const headers: Record<string, string> = {};
    for (const [key, value] of c.req.raw.headers.entries()) {
        if (!key.toLowerCase().startsWith("cf-")) {
            headers[key] = value;
        }
    }

    if (format === ApiFormat.ANTHROPIC) {
        headers["x-api-key"] = vendor.token;
        headers["anthropic-version"] = "2023-06-01";
    } else {
        headers["Authorization"] = vendor.token;
    }

    // 3. 发起上游请求，拿到响应头后立即判断响应类型
    console.log("do fetch upstream, url:", url);
    const upstreamRes = await fetch(url, { method: "POST", headers, body });
    console.log("upstream response status:", upstreamRes.status);

    const isStream =
        upstreamRes.ok &&
        upstreamRes.headers.get("content-type")?.startsWith("text/event-stream");

    // 4. 按响应类型分发处理
    if (isStream) {
        return handleStreamResponse(c, upstreamRes, record, format);
    } else {
        return handleNonStreamResponse(c, upstreamRes, record, format);
    }
}


export default {
    sendRequest,
};
