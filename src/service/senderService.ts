import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { StatusCode } from "hono/dist/types/utils/http-status";
import enhanced from "../util/enhanced";
import { streamSSE, SSEStreamingApi } from "hono/streaming";
import {
    EventStreamContentType,
    fetchEventSource,
} from "@fortaine/fetch-event-source";
import { SgUser } from "../model/sgUser";
import { SgVendor } from "../model/sgVendor";
import recordService from "./recordService";
import { SgRecordStatus, ApiFormat } from "../constants";
import sseAccumulator from "../util/sseAccumulator";

/**
 * 发送请求到上游 AI 服务
 *
 * @param c - Hono 上下文对象
 * @param user - 用户信息
 * @param modelConfig - 模型配置
 * @param vendor - 供应商信息
 * @param format - API 格式（openai 或 anthropic）
 * @returns Promise<Response> - 响应对象
 */
async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    vendor: SgVendor,
    format: ApiFormat,
): Promise<Response> {
    const url = vendor.getUrlByFormat(format);

    // 1. 获取请求体，并创建数据库记录
    let body: string = await c.req.text();
    const record = await recordService.create(user.id, modelConfig.id, body);
    await recordService.update(record.id, {
        status: SgRecordStatus.PROCESSING,
        start_at: new Date().toISOString(),
    });
    const recordId = record.id;

    console.log("sendRequest: modelConfig={}", modelConfig);

    // 2. 初始化变量
    let isStreamResponse: boolean = true; // 是否为流式响应
    let upstreamStatusCode: StatusCode | null = null; // 上游响应状态码
    let upstreamResponseText: string | null = null; // 上游响应文本（非流式）
    const accumulator = new sseAccumulator.SSEAccumulator(
        format === ApiFormat.ANTHROPIC ? 'anthropic' : 'openai'
    ); // SSE 消息累加器
    let firstTokenTime: number | null = null; // 首个 token 时间

    // 自定义 Promise，用于等待响应头到达（判断是否为流式）
    let getResponseHeaderPromise: enhanced.CustomPromise<void> = new enhanced.CustomPromise();

    console.log("body:", body);

    // 3. 构建上游请求选项
    // 过滤掉 Cloudflare 添加的 header（以 cf- 开头）
    let headers: Record<string, string> = {};

    for (const [key, value] of c.req.raw.headers.entries()) {
        // 过滤条件：不以 cf- 开头
        if (!key.toLowerCase().startsWith("cf-")) {
            headers[key] = value;
        }
    }

    if (format === ApiFormat.ANTHROPIC) {
        headers["x-api-key"] = vendor!.token!;
        headers["anthropic-version"] = "2023-06-01";
    } else {
        headers["Authorization"] = vendor!.token!;
    }

    let requestOptions = {
        method: "POST",
        headers: headers,
        body: body,
    };
    console.log("requestOptions:", requestOptions);

    let upstreamReqPromise: Promise<void> | null = null; // 上游请求 Promise
    let streamOutputPipe: SSEStreamingApi | null = null; // 流式输出管道

    console.log("do fetch upstream");

    // 4. 发起 SSE 请求到上游服务
    upstreamReqPromise = fetchEventSource(url, {
        ...requestOptions,
        // 响应打开时触发
        async onopen(response: Response) {
            upstreamStatusCode = response.status as StatusCode;

            // 如果响应成功且是 SSE 流
            if (
                response.ok &&
                response.headers
                    .get("content-type")
                    ?.startsWith(EventStreamContentType)
            ) {
                console.log("onOpen:", response);
                getResponseHeaderPromise.resolve(null); // 解除阻塞，可以开始返回流式响应
                return; // everything's good

                // 如果是客户端错误（通常不可重试）
            } else if (
                response.status >= 400 &&
                response.status < 500 &&
                response.status !== 429
            ) {
                console.log("onOpen, but has error:", response);
                isStreamResponse = false; // 标记为非流式响应

                const contentType = response.headers.get("content-type");
                console.log("upstream response content type: ", contentType);

                // 读取响应文本
                if (
                    contentType?.startsWith("text/plain") ||
                    contentType?.startsWith("application/json")
                ) {
                    upstreamResponseText = await response.clone().text();
                    console.log("statusCode:", response.status);
                    console.log("responseText:", upstreamResponseText);
                }

                console.log("fallback to json response");
                getResponseHeaderPromise.resolve(null);

                // 其他情况（非流式响应）
            } else {
                console.log("onOpen, but content-type not except:", response);
                isStreamResponse = false;
                upstreamResponseText = await response.clone().text();
                console.log("statusCode:", response.status);
                console.log("responseText:", upstreamResponseText);

                getResponseHeaderPromise.resolve(null);
            }
        },
        // 收到 SSE 消息时触发
        async onmessage(msg) {
            console.log("onMessage:", msg);

            // 记录首个 token 的时间
            if (firstTokenTime === null && msg.data !== "[DONE]") {
                firstTokenTime = Date.now();
            }

            // 检查是否是 [DONE] 标和其他特殊消息
            if (msg.data === "[DONE]") {
                // 直接转发，不尝试解析
                await streamOutputPipe!.writeSSE(msg);
                return;
            }

            try {
                // 累积消息到累加器
                const data = JSON.parse(msg.data);
                accumulator.addMessage(data);

                await streamOutputPipe!.writeSSE(msg); // 将消息转发给客户端
            } catch (e) {
                console.log("Failed to parse message data:", msg.data, e);
                // 仍然转发原始消息
                await streamOutputPipe!.writeSSE(msg);
            }
        },
        // 连接关闭时触发
        onclose() {
            console.log("onClose");
            getResponseHeaderPromise.resolve(null);
        },
        // 发生错误时触发
        onerror(err: Response) {
            console.log("onerror:", err);
            getResponseHeaderPromise.resolve(null);
        },
    });

    // 5. 等待响应头到达，判断响应类型
    console.log(
        "before await getResponseHeaderPromise",
        getResponseHeaderPromise,
    );
    await getResponseHeaderPromise;
    console.log(
        "after getResponseHeaderPromise finished",
        getResponseHeaderPromise,
    );
    console.log("isStreamResponse:", isStreamResponse);

    // 6. 根据响应类型返回结果
    // 流式响应
    if (isStreamResponse === true) {
        // 准备 SSE 流式响应
        let streamSSEResponse = streamSSE(
            c,
            async (stream: SSEStreamingApi) => {
                streamOutputPipe = stream; // 设置输出管道
                console.log(
                    "before await upstreamReqPromise",
                    upstreamReqPromise,
                );
                await upstreamReqPromise; // 等待上游请求完成
                console.log(
                    "after upstreamReqReqromise finished",
                    upstreamReqPromise,
                );

                // 流式响应完成后，保存完整响应到数据库
                const fullResponse = accumulator.getResponse();
                const endTime = new Date().toISOString();

                // 提取统计数据
                const stats = {
                    prompt_tokens: fullResponse.usage?.prompt_tokens ?? null,
                    output_tokens: fullResponse.usage?.completion_tokens ?? null,
                    first_token_latency: firstTokenTime !== null
                        ? firstTokenTime - new Date(record.created_at as any).getTime()
                        : null,
                    end_at: endTime,
                };

                await recordService.update(recordId, {
                    response_data: JSON.stringify(fullResponse),
                    status: SgRecordStatus.SUCCESS,
                    ...stats,
                });
            },
        );
        return streamSSEResponse;

        // 非流式响应
    } else {
        const endTime = new Date().toISOString();

        // 解析响应数据以提取 token 信息
        let promptTokens: number | null = null;
        let outputTokens: number | null = null;
        if (upstreamResponseText) {
            try {
                const responseJson = JSON.parse(upstreamResponseText);
                if (format === ApiFormat.ANTHROPIC) {
                    // Anthropic 格式: usage.input_tokens, usage.output_tokens
                    promptTokens = responseJson.usage?.input_tokens ?? null;
                    outputTokens = responseJson.usage?.output_tokens ?? null;
                } else {
                    // OpenAI 格式: usage.prompt_tokens, usage.completion_tokens
                    promptTokens = responseJson.usage?.prompt_tokens ?? null;
                    outputTokens = responseJson.usage?.completion_tokens ?? null;
                }
            } catch (e) {
                console.log("Failed to parse response for token stats:", e);
            }
        }

        // 更新数据库记录
        await recordService.update(recordId, {
            response_data: upstreamResponseText,
            status:
                upstreamStatusCode == 200
                    ? SgRecordStatus.SUCCESS
                    : SgRecordStatus.FAILED,
            prompt_tokens: promptTokens,
            output_tokens: outputTokens,
            end_at: endTime,
        });

        // 返回 JSON 响应
        c.status(upstreamStatusCode!);
        c.res.headers.set("Content-Type", "application/json");
        return c.text(upstreamResponseText!);
    }
}

export default {
    sendRequest,
};
