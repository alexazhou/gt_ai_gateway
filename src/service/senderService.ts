import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { SgUser } from "../model/sgUser";
import { SgVendor } from "../model/sgVendor";
import { SgRecord } from "../model/sgRecord";
import recordService from "./recordService";
import requestActivityService from "./requestActivityService";
import { SgRecordStatus, ApiFormat, VendorAuthMode, FailedCode, RequestActivityStage, ActivityLevel, ConfigKey } from "../constants";
import pluginService from "./pluginService";
import hostService from "./hostService";
import { ConverterFactory } from "../util/protocolConverter/ConverterFactory";
import type { BaseConverter } from "../util/protocolConverter/BaseConverter";
import customError from "../customError";
import streamLogService from "./streamLogService";
import responseHandlerService from "./responseHandlerService";
import fetchUtil from "../util/fetchUtil";
import routingService, { type ModelRoutingResult } from "./routingService/core";
import configService from "./configService";
import upstreamHealthService from "./upstreamHealthService";
import abortTimeoutUtil from "../util/abortTimeoutUtil";
import RoutingContext from "./routingService/routingContext";
import ruleService from "./ruleService";


// 可重试的 HTTP 错误响应转成异常，与网络异常汇入同一个失败处理点
class UpstreamResponseError extends Error {
    constructor(readonly response: Response) {
        super(`Upstream returned retryable status ${response.status}`);
    }
}


// 网络异常合成 502 错误响应，与 HTTP 错误响应统一为 Response 回传
function buildUpstreamFailureResponse(c: Context, error: unknown): Response {
    const appError = new customError.AppError(
        `All upstreams failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
    );
    const apiFormat = c.get("api_format");
    const body = apiFormat
        ? customError.buildLlmErrorResponse(appError, apiFormat)
        : { error: appError.message, code: appError.code };
    return c.json(body, 502);
}


// 供应商级限流合成 429 错误响应（与 onError 一致的协议错误体 + Retry-After 头）。
// 供阶段二 failover 关闭 / 直接返回时使用；全部耗尽时复用同样的 429 响应。
function buildRateLimitResponse(c: Context, error: InstanceType<typeof customError.RateLimitError>): Response {
    const apiFormat = c.get("api_format");
    const body = apiFormat
        ? customError.buildLlmErrorResponse(error, apiFormat)
        : { error: error.message, code: error.code };
    const response = c.json(body, 429);
    response.headers.set("Retry-After", String(error.retryAfterSeconds ?? 60));
    return response;
}


// inspect 模式下脱敏上游请求头，避免认证信息泄露给调用方
function sanitizeUpstreamHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        result[key] =
            lower === "authorization" || lower === "x-api-key"
                ? (value.length > 12 ? value.slice(0, 8) + "****" + value.slice(-4) : "****")
                : value;
    });
    return result;
}


async function sendRequestToUpstream(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    record: SgRecord,
    vendor: SgVendor,
    vendorModelName: string,
    clientFormat: ApiFormat,
    upstreamFormat: ApiFormat,
    body: string,
): Promise<Response> {
    // 客户端格式与最终上游格式已在 sendRequest 解析好，这里直接使用
    const needsConversion = clientFormat !== upstreamFormat;

    const url = vendor.getUrlByFormat(upstreamFormat);
    if (url === null) {
        throw new customError.AppError(`vendor does not have url for ${upstreamFormat} format`, 400);
    }

    console.log("sendRequestToUpstream: modelConfig={}, clientFormat={}, upstreamFormat={}", modelConfig, clientFormat, upstreamFormat);

    // 余额扣减在响应处理阶段完成（responseHandlerService），这里仅对非 root 用户记录余额快照（单位：整数微元）
    if (user.type !== "root") {
        console.log(`[senderService] Checking balance for user ${user.id}: ${user.balance}`);
    }

    // 1. 记录本次上游尝试：跨尝试更新同一条 record，最终保留最后一次尝试（即最终命中的上游）
    const recordId = Number(record.id);
    await recordService.update(recordId, {
        status: SgRecordStatus.PROCESSING,
        vendor_id: vendor.id,
        vendor_model_name: vendorModelName,
        upstream_format: upstreamFormat !== clientFormat ? upstreamFormat : null,
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
        "cookie",
        "accept",
        "accept-encoding",
        "accept-language",
        "priority",
        "user-agent",
    ];

    for (const [key, value] of c.req.raw.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (
            !lowerKey.startsWith("cf-") &&
            !lowerKey.startsWith("sec-") &&
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
    // 显式上游替换成 vendor model 名；自动上游名与网关模型名一致，替换为无操作
    if (vendorModelName) {
        try {
            const bodyJson = JSON.parse(upstreamBody);
            bodyJson.model = vendorModelName;
            upstreamBody = JSON.stringify(bodyJson);
        } catch (e) {
            console.log("[senderService] Failed to substitute model name:", e);
        }
    }

    // 4. 应用插件 (转换前)
    const hostKey = await hostService.getHostKey();
    const prePluginBody = upstreamBody;
    upstreamBody = await pluginService.applyRequestPlugins(upstreamBody, clientFormat, hostKey, user.name);
    if (upstreamBody !== prePluginBody) {
        await requestActivityService.append(recordId, RequestActivityStage.PLUGIN, "应用请求插件（转换前）", {
            format: clientFormat,
            body_len_before: prePluginBody.length,
            body_len_after: upstreamBody.length,
        });
    }

    let converter: BaseConverter | null = null;
    if (needsConversion) {
        converter = ConverterFactory.create(clientFormat, upstreamFormat);
        if (!converter) {
            throw new customError.AppError(
                `Unsupported protocol conversion: ${clientFormat} → ${upstreamFormat}`,
                400,
            );
        }
        console.log(`[senderService] Using protocol converter: ${converter.constructor.name}, client=${clientFormat}, upstream=${upstreamFormat}`);
        upstreamBody = converter.convertRequestBody(upstreamBody);
        await requestActivityService.append(recordId, RequestActivityStage.CONVERSION, "协议转换", {
            from: clientFormat,
            to: upstreamFormat,
            converter: converter.constructor.name,
        });
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
        const prePostPluginBody = upstreamBody;
        upstreamBody = await pluginService.applyRequestPlugins(upstreamBody, upstreamFormat, hostKey, user.name);
        if (upstreamBody !== prePostPluginBody) {
            await requestActivityService.append(recordId, RequestActivityStage.PLUGIN, "应用请求插件（转换后）", {
                format: upstreamFormat,
                body_len_before: prePostPluginBody.length,
                body_len_after: upstreamBody.length,
            });
        }
    }

    await streamLogService.writeRequestLog(record, upstreamBody);

    // inspect 模式（专用测试接口使用）：把本次（最终命中的）上游实际请求快照注入 c，
    // 供调用方返回给前端展示。生产路径不带 inspect 标记，此处零开销。
    if (c.get("inspectUpstream")) {
        c.set("upstreamRequestSnapshot", {
            url,
            method: "POST",
            headers: sanitizeUpstreamHeaders(finalHeaders),
            body: upstreamBody,
            client_format: clientFormat,
            upstream_format: upstreamFormat,
            vendor: { id: vendor.id, name: vendor.name },
            vendor_model_name: vendorModelName,
            proxy: vendor.config.proxy ?? null,
        });
    }

    // 7. 发起上游请求，拿到响应头后立即判断响应类型
    await requestActivityService.append(recordId, RequestActivityStage.UPSTREAM_ATTEMPT, "发起上游请求", {
        vendor_id: vendor.id,
        vendor_name: vendor.name,
        vendor_model_name: vendorModelName,
        url,
        upstream_format: upstreamFormat,
    });

    // 响应头超时：只约束「连接 + 响应头」阶段；配置值 <= 0 表示关闭超时。
    // fetch 返回后 dispose 会移除客户端断开监听——body 阶段（流式 / 非流式）由各 handler
    // 自己的 abort 监听兜底，handler 在注册监听时会先检查信号是否已中断。
    const headersTimeoutMs = await configService.getNumber(ConfigKey.UPSTREAM_HEADERS_TIMEOUT_MS);
    const clientAbortCtrl = new abortTimeoutUtil.TimeoutAbortController(headersTimeoutMs, c.req.raw.signal);

    let upstreamRes: Response;
    try {
        // 如果该 vendor 配置了跳过 TLS 验证（内网自签证书场景），注入 undici Agent
        const dispatcher = await fetchUtil.getDispatcher(vendor.config);
        upstreamRes = await fetch(url, {
            method: "POST",
            headers: finalHeaders,
            body: upstreamBody,
            signal: clientAbortCtrl.signal,
            // dispatcher 是 undici (Node.js) 特有选项，不在 Cloudflare Workers 的 RequestInit 类型定义中
            ...(dispatcher ? { dispatcher: dispatcher } as any : {}),
        });
    } catch (e: any) {
        console.error("Upstream fetch failed:", e);
        await recordService.markFailed(recordId, clientAbortCtrl.failedCode(), {
            stage: RequestActivityStage.UPSTREAM_ATTEMPT,
            message: "上游请求失败",
            level: ActivityLevel.ERROR,
            response_data: String(e),
            detail: {
                vendor_id: vendor.id,
                vendor_name: vendor.name,
                url,
                error: e instanceof Error ? e.message : String(e),
            },
        });
        throw e;
    } finally {
        clientAbortCtrl.dispose();
    }
    console.log("upstream response status:", upstreamRes.status);

    const isStream =
        upstreamRes.ok &&
        upstreamRes.headers.get("content-type")?.startsWith("text/event-stream");

    // 8. 按响应类型分发处理（三种协议统一走 responseHandlerService，按 clientFormat 选累加器/解析口径）
    if (isStream) {
        return responseHandlerService.handleStreamResponse(c, upstreamRes, record, modelConfig, user, clientFormat, upstreamFormat, converter);
    }
    return responseHandlerService.handleNonStreamResponse(c, upstreamRes, record, modelConfig, user, upstreamFormat, converter);
}


async function sendRequest(
    c: Context,
    user: SgUser,
    modelConfig: SgModel,
    clientFormat: ApiFormat,
    body: string,
    options: { inspect?: boolean } = {},
): Promise<Response> {
    // inspect 模式：在 c 上打标记，sendRequestToUpstream 据此把上游请求快照注入 c（供专用测试接口使用）
    if (options.inspect) {
        c.set("inspectUpstream", true);
    }

    // 租户作用域（LLM 路径由 llmApiMiddleware 注入；缺失时兜底不落租户）
    const scope = c.get("tenantScope");
    const tenantId = scope?.tenantId;
    const mainTenantId = scope?.mainTenantId;

    // 预检：仅全局计费开启时检查余额（module_billing_enabled 关闭则完全不拦）。
    // 余额为负的用户阻止请求，不向上游发起（负余额在完成时扣减产生，充值前不再放行）
    // balance 为整数微元，负值即欠费；但未启用计费（价格未设置或为 0）的模型不拦截
    const billingEnabled = await configService.isModuleBillingEnabled();
    if (billingEnabled && user.balance < 0 && modelConfig.hasBilling()) {
        await recordService.recordFailedRequest(
            user.id,
            modelConfig.name,
            body,
            clientFormat,
            FailedCode.INSUFFICIENT_BALANCE,
            modelConfig.id,
            undefined,
            undefined,
            tenantId,
        );
        throw new customError.AppError("Insufficient balance", 400);
    }

    // 一条用户请求 = 一条 record：进入路由循环前创建一次，跨上游尝试更新同一条记录
    const record = await recordService.create(user.id, modelConfig.id, body, clientFormat, tenantId);
    const recordId = Number(record.id);

    // 每个原始请求一个路由上下文，记录已用后端，避免重试循环
    const routingContext = new RoutingContext();
    // 失败切换开关在请求内不变，循环外取一次
    const failoverEnabled = modelConfig.getRoutingConfig().failover.enabled;
    let lastFailure: Response | null = null;
    // 记录最后一次失败对应的失败码：全部上游耗尽时（lastFailure 非空）用其标记 record，区分「限流耗尽」与「网络/HTTP 失败」
    let lastFailureCode: string | null = null;

    while (true) {
        let routingResult: ModelRoutingResult;
        try {
            routingResult = await routingService.selectUpstream(
                modelConfig,
                clientFormat,
                routingContext,
                c,   // 从请求 context 读取用户，供负载均衡"按用户随机"模式做种子
            );
        } catch (e) {
            // 路由阶段异常（如配置错误无启用上游）：同样是一次失败请求，不留 init 孤儿记录
            await recordService.update(recordId, {
                status: SgRecordStatus.FAILED,
                end_at: new Date(),
            });
            throw e;
        }
        // 无可用上游时 selectUpstream 返回上游为 null 的空结果
        if (!routingResult.hasUpstream()) {
            // 全部后端已用尽（lastFailure 非空）或一开始就无可用上游，都属于一次真实请求，记 FAILED
            const exhausted = lastFailure !== null;
            await recordService.update(recordId, {
                status: SgRecordStatus.FAILED,
                ...(exhausted
                    ? (lastFailureCode ? { failed_code: lastFailureCode } : {})
                    : { failed_code: FailedCode.NO_AVAILABLE_UPSTREAM }),
                end_at: new Date(),
            });
            await requestActivityService.append(
                recordId,
                RequestActivityStage.ROUTING,
                exhausted ? "所有上游均已尝试，无可用上游" : "无可用上游",
                exhausted ? undefined : { failed_code: FailedCode.NO_AVAILABLE_UPSTREAM },
                ActivityLevel.ERROR,
            );
            // 全部后端已用尽：统一回传最后一次失败（HTTP 错误原样 / 网络异常 502 响应）
            if (lastFailure) {
                return lastFailure;
            }
            // 一开始就没有可用上游（全部冷却中 / 未启用）
            throw new customError.AppError("No available upstream", 503);
        }

        // vendor 与上游模型/最终格式已在选择阶段解析，结果直接携带，无需再查库
        const vendor = routingResult.vendor;
        const vendorModelName = routingResult.vendorModelName;
        const upstreamFormat = routingResult.upstreamFormat;

        await requestActivityService.append(recordId, RequestActivityStage.ROUTING, "路由选择", {
            strategy: modelConfig.routing_mode,
            client: {
                model: modelConfig.name,
                format: clientFormat,
            },
            upstream: {
                vendor: vendor.name,
                vendor_model: vendorModelName,
                format: upstreamFormat,
            },
        });

        // 【阶段二】路由后准入检查（含 vendor_id 的规则，实际路由到的供应商已确定）。
        // inspect 模式（route-test 纯诊断）跳过，不计数、不受限流/访问控制影响。
        if (!options.inspect) {
            try {
                await ruleService.matchAndCheckVendor(
                    user,
                    modelConfig,
                    vendor,
                    tenantId ?? -1,
                    mainTenantId ?? tenantId ?? -1,
                );
            } catch (e) {
                if (e instanceof customError.AccessDeniedError) {
                    // 403：策略性拒绝与供应商无关，不 failover；标记 record FAILED 后抛出，交给 onError 渲染
                    await recordService.markFailed(recordId, FailedCode.ACCESS_DENIED, {
                        message: "命中规则被拦截",
                        detail: {
                            rule_message: e.message,
                            rule_id: e.ruleId,
                            rule_name: e.ruleName,
                        },
                    });
                    throw e;
                }
                if (e instanceof customError.RateLimitError) {
                    // 429：视为「该上游繁忙」——failover 开启时把 429 存入 lastFailure 继续尝试下一上游
                    //（selectUpstream 已 markTried，自动跳过）；关闭时直接返回 429（返回前标记 record FAILED）
                    if (failoverEnabled) {
                        lastFailure = buildRateLimitResponse(c, e);
                        lastFailureCode = FailedCode.RATE_LIMIT_EXCEEDED;
                        c.status(200);
                        continue;
                    }
                    await recordService.markFailed(recordId, FailedCode.RATE_LIMIT_EXCEEDED, {
                        message: "命中规则被拦截",
                        detail: {
                            rule_message: e.message,
                            rule_id: e.ruleId,
                            rule_name: e.ruleName,
                        },
                    });
                    return buildRateLimitResponse(c, e);
                }
                throw e;
            }
        }

        try {
            const response = await sendRequestToUpstream(
                c,
                user,
                modelConfig,
                record,
                vendor,
                vendorModelName,
                clientFormat,
                upstreamFormat,
                body,
            );

            // 上游返回非成功响应，转成异常统一走下面的失败处理点，尝试下一个上游
            if (!response.ok) {
                throw new UpstreamResponseError(response);
            }

            return response;
        } catch (e: any) {
            if (c.req.raw.signal.aborted || e instanceof customError.AppError) {
                throw e;
            }

            // 唯一的失败处理点：HTTP 错误与网络异常在这里汇合
            const httpFailure = e instanceof UpstreamResponseError;

            // 全局冷却：仅上游自身故障才标记（5xx、402 余额不足、网络不可达），
            // 4xx 请求侧错误不惩罚上游，避免健康上游被无辜跳过（本请求的循环防护由 routingContext 承担）
            const failureStatus = httpFailure ? e.response.status : null;
            if (upstreamHealthService.shouldMarkFailure(failureStatus)) {
                upstreamHealthService.markFailure(vendor.id, vendorModelName, upstreamFormat);
            }

            // failover 关闭：HTTP 错误直接回传响应，网络异常抛原始异常，不继续尝试
            if (!failoverEnabled) {
                if (httpFailure) {
                    return e.response;
                }
                throw e;
            }

            // 切换动作由时间线自然体现（上一次尝试的结果 → 下一次路由选择），不再单独记 failover 活动
            lastFailure = httpFailure
                ? e.response
                : buildUpstreamFailureResponse(c, e);
            c.status(200);   // 复位上下文状态，避免上次失败的 error 状态影响下一次尝试
        }
    }
}

export default {
    sendRequest,
};
