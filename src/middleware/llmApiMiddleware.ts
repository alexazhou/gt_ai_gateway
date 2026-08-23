import { Context, MiddlewareHandler } from "hono";
import { ApiFormat, FailedCode, UserStatus } from "../constants";
import userService from "../service/userService";
import llmRequestService from "../service/llmRequestService";
import recordService from "../service/recordService";
import ruleService from "../service/ruleService";
import { SgUser } from "../model/sgUser";
import customError from "../customError";
import { resolveScopeForUser } from "./tenantScopeMiddleware";


function extractLlmToken(c: Context): string {
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(\S+)\s*$/i);
        if (!match) {
            throw new customError.AppError("Invalid Authorization header", 401, "authentication_error");
        }
        return match[1];
    }

    const apiKey = c.req.header("x-api-key")?.trim();
    if (apiKey) {
        return apiKey;
    }

    throw new customError.AppError(
        "Authorization or x-api-key header is missing",
        401,
        "authentication_error",
    );
}


function parseLlmRequestBody(body: string): string {
    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        throw new customError.AppError("Invalid JSON body", 400, "invalid_request_error");
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new customError.AppError("Request body must be a JSON object", 400, "invalid_request_error");
    }

    const modelName = (payload as Record<string, unknown>).model;
    if (typeof modelName !== "string" || modelName.trim() === "") {
        throw new customError.AppError("model parameter is missing or invalid", 400, "invalid_request_error");
    }

    return modelName;
}


async function authenticateLlmUser(c: Context): Promise<SgUser> {
    const token = extractLlmToken(c);
    const user = await userService.getUserByToken(token, c.env.ROOT_TOKEN);
    if (user == null) {
        throw new customError.AppError("Invalid token (user not found)", 401, "authentication_error");
    }
    if (user.status === UserStatus.DISABLED) {
        throw new customError.AppError("User disabled", 403, "authentication_error");
    }

    return user;
}


const requireLlmRequestContext = (format: ApiFormat): MiddlewareHandler => {
    return async (c: Context, next) => {
        c.set("api_format", format);
        const user = await authenticateLlmUser(c);

        // 租户作用域：root 取 X-Tenant-ID（缺失默认 main），非 root 固定自身租户
        const scope = await resolveScopeForUser(user, c.req.header("X-Tenant-ID"));
        c.set("tenantScope", scope);

        const body = await c.req.text();
        const modelName = parseLlmRequestBody(body);
        const { modelConfig } = await llmRequestService.resolveContext(
            user.id,
            modelName,
            body,
            format,
            scope,
        );

        c.set("user", user);
        c.set("requestBody", body);
        c.set("modelConfig", modelConfig);

        // 【阶段一】路由前准入检查（不含 vendor_id 的规则）：命中 forbid_access 抛 403、rate_limit 超限抛 429。
        // 被拒时写入失败记录（此时 user / modelConfig / requestBody 均在 context），再交给 onError 渲染错误体。
        try {
            await ruleService.matchAndCheck(user, modelConfig, scope.tenantId, scope.mainTenantId);
        } catch (e) {
            if (e instanceof customError.AccessDeniedError) {
                await recordService.recordFailedRequest(
                    user.id,
                    modelConfig.name,
                    body,
                    format,
                    FailedCode.ACCESS_DENIED,
                    modelConfig.id,
                    "命中规则被拦截",
                    { rule_id: e.ruleId, rule_name: e.ruleName },
                    scope.tenantId,
                );
            } else if (e instanceof customError.RateLimitError) {
                await recordService.recordFailedRequest(
                    user.id,
                    modelConfig.name,
                    body,
                    format,
                    FailedCode.RATE_LIMIT_EXCEEDED,
                    modelConfig.id,
                    "命中规则被拦截",
                    { rule_id: e.ruleId, rule_name: e.ruleName },
                    scope.tenantId,
                );
            }
            throw e;
        }

        await next();
    };
};


const requireLlmModelsAuth: MiddlewareHandler = async (c: Context, next) => {
    c.set("api_format", ApiFormat.OPENAI);
    const user = await authenticateLlmUser(c);
    c.set("user", user);
    const scope = await resolveScopeForUser(user, c.req.header("X-Tenant-ID"));
    c.set("tenantScope", scope);
    await next();
};

export default { requireLlmRequestContext, requireLlmModelsAuth };
