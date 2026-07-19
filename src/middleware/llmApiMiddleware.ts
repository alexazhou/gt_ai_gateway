import { Context, MiddlewareHandler } from "hono";
import { ApiFormat, UserStatus } from "../constants";
import userService from "../service/userService";
import llmRequestService from "../service/llmRequestService";
import { SgUser } from "../model/sgUser";
import customError from "../util/customError";


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

        const body = await c.req.text();
        const modelName = parseLlmRequestBody(body);
        const { modelConfig } = await llmRequestService.resolveContext(
            user.id,
            modelName,
            body,
            format,
        );

        c.set("user", user);
        c.set("requestBody", body);
        c.set("modelConfig", modelConfig);

        await next();
    };
};


const requireLlmModelsAuth: MiddlewareHandler = async (c: Context, next) => {
    c.set("api_format", ApiFormat.OPENAI);
    const user = await authenticateLlmUser(c);
    c.set("user", user);
    await next();
};

export default { requireLlmRequestContext, requireLlmModelsAuth };
