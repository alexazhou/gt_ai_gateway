import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { SgUser } from "../model/sgUser";
import { SgVendor } from "../model/sgVendor";
import { SgVendorModel } from "../model/sgVendorModel";
import recordService from "./recordService";
import { SgRecordStatus, ApiFormat, VendorAuthMode } from "../constants";
import pluginService from "./pluginService";
import hostService from "./hostService";
import { ConverterFactory } from "../util/protocolConverter/ConverterFactory";
import type { BaseConverter } from "../util/protocolConverter/BaseConverter";
import customError from "../util/customError";
import protocolUtils from "../util/protocolUtils";
import streamLogService from "./streamLogService";
import responseHandlerService from "./responseHandlerService";
import fetchUtil from "../util/fetchUtil";
import modelRoutingService, { type ModelRoutingResult } from "./modelRoutingService";


async function sendRequestToUpstream(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    vendor: SgVendor,
    format: ApiFormat,
    body: string,
    vendorModelId: number,
): Promise<Response> {
    let vendorModelName: string | null = null;
    let supportedFormats: ApiFormat[] | null = null;

    if (vendorModelId) {
        const vendorModel = await SgVendorModel.query().find(vendorModelId);
        if (vendorModel) {
            vendorModelName = vendorModel.model_id;
            supportedFormats = vendorModel.getSupportedFormats();
        }
    }

    // 如果 vendorModel 未配置限制格式，使用 vendor 支持的格式
    if (!supportedFormats) {
        supportedFormats = vendor.getSupportedFormats();
    }

    // 根据客户端请求的格式和 vendor/vendorModel 支持的格式，计算最终应该用什么格式
    const upstreamFormat = protocolUtils.resolveUpstreamFormat(format, supportedFormats);

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
    const record = await recordService.create(
        user.id,
        modelConfig.id,
        body,
        format,
        upstreamFormat,
        vendor.id,
        vendorModelName
    );
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
        if (vendor.config.auth_mode === VendorAuthMode.BEARER_TOKEN) {
            finalHeaders.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
        } else {
            finalHeaders.set("x-api-key", vendor.token);
            finalHeaders.set("anthropic-version", "2023-06-01");
        }
    } else {
        finalHeaders.set("Authorization", vendor.token.startsWith("Bearer ") ? vendor.token : `Bearer ${vendor.token}`);
    }

    // 强制设置 content-type
    finalHeaders.set("Content-Type", "application/json");

    // 3. 替换上游模型名
    let upstreamBody = body;
    if (vendorModelId) {
        const vendorModel = await SgVendorModel.query().find(vendorModelId);
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

    // 4. 应用插件 (转换前)
    const hostKey = await hostService.getHostKey();
    upstreamBody = await pluginService.applyRequestPlugins(upstreamBody, format, hostKey, user.name);

    let converter: BaseConverter | null = null;
    if (needsConversion) {
        converter = ConverterFactory.create(format, upstreamFormat);
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

    // 5. OpenAI 流式请求注入 stream_options，让上游在最后一帧返回 usage
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

    // 6. 应用插件 (转换后)
    if (needsConversion) {
        upstreamBody = await pluginService.applyRequestPlugins(upstreamBody, upstreamFormat, hostKey, user.name);
    }

    await streamLogService.writeRequestLog(record, upstreamBody);

    // 7. 发起上游请求，拿到响应头后立即判断响应类型
    let upstreamRes: Response;
    try {
        // 如果该 vendor 配置了跳过 TLS 验证（内网自签证书场景），注入 undici Agent
        const dispatcher = await fetchUtil.getDispatcher(vendor.config);
        upstreamRes = await fetch(url, {
            method: "POST",
            headers: finalHeaders,
            body: upstreamBody,
            signal: c.req.raw.signal,
            // dispatcher 是 undici (Node.js) 特有选项，不在 Cloudflare Workers 的 RequestInit 类型定义中
            ...(dispatcher ? { dispatcher: dispatcher } as any : {}),
        });
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

    // 8. 按响应类型分发处理
    if (format === ApiFormat.RESPONSES) {
        if (isStream) {
            return responseHandlerService.handleResponsesStreamResponse(c, upstreamRes, record, modelConfig, user, converter, upstreamFormat);
        } else {
            return responseHandlerService.handleResponsesNonStreamResponse(c, upstreamRes, record, modelConfig, user, converter, upstreamFormat);
        }
    }

    if (isStream) {
        return responseHandlerService.handleChatStreamResponse(c, upstreamRes, record, modelConfig, user, format, upstreamFormat, converter);
    } else {
        return responseHandlerService.handleChatNonStreamResponse(c, upstreamRes, record, modelConfig, user, format, upstreamFormat, converter);
    }
}


async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    format: ApiFormat,
    body: string,
): Promise<Response> {
    while (true) {
        const routingResult: ModelRoutingResult | null = await modelRoutingService.selectUpstream(
            modelConfig,
            format,
        );
        if (!routingResult) {
            throw new customError.AppError("No available upstream", 503);
        }

        const vendorModel = await SgVendorModel.query().find(routingResult.vendorModelId);
        if (!vendorModel) {
            throw new customError.AppError("Vendor model not found", 503);
        }

        const vendor = await SgVendor.query().find(vendorModel.vendor_id);
        if (!vendor) {
            throw new customError.AppError("Vendor not found", 503);
        }

        const supportedFormats = vendorModel.getSupportedFormats() ?? vendor.getSupportedFormats();
        const upstreamFormat = protocolUtils.resolveUpstreamFormat(format, supportedFormats);

        try {
            const response = await sendRequestToUpstream(
                c,
                user,
                modelConfig,
                vendor,
                format,
                body,
                routingResult.vendorModelId,
            );

            if (!response.ok && modelRoutingService.isRetryableStatus(response.status)) {
                const failureRecorded = await modelRoutingService.markFailure(routingResult, upstreamFormat);
                if (failureRecorded) {
                    c.status(200);
                    continue;
                }
            }

            return response;
        } catch (e: any) {
            if (c.req.raw.signal.aborted || e instanceof customError.AppError) {
                throw e;
            }

            const failureRecorded = await modelRoutingService.markFailure(routingResult, upstreamFormat);
            if (failureRecorded) {
                continue;
            }

            throw e;
        }
    }
}

export default {
    sendRequest,
};
