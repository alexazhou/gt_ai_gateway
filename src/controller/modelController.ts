import { Context } from "hono";
import { SgModel } from "../model/sgModel";
import { ApiFormat } from "../constants";
import modelManager from "../manager/modelManager";
import modelService from "../service/modelService";
import sender from "../service/senderService";
import userService from "../service/userService";
import customError from "../customError";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";


function parseJsonLike(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}


// 构建模型路由测试的客户端请求体（与前端 runRoutingTest 原请求一致）
function buildTestRequestBody(format: ApiFormat, model: string): string {
    if (format === ApiFormat.ANTHROPIC) {
        return JSON.stringify({
            model,
            messages: [{ role: "user", content: "你好" }],
            max_tokens: 256,
        });
    }
    if (format === ApiFormat.RESPONSES) {
        return JSON.stringify({
            model,
            input: "你好",
            max_output_tokens: 256,
        });
    }
    return JSON.stringify({
        model,
        messages: [{ role: "user", content: "你好" }],
        max_tokens: 256,
        stream: false,
    });
}


function createModelFromRequest(body: unknown): SgModel {
    if (
        !body
        || typeof body !== "object"
        || !("routing_mode" in body)
        || !("routing_config" in body)
    ) {
        throw new customError.AppError("routing_mode and routing_config are required");
    }

    return new SgModel(body as Record<string, unknown>);
}


async function createModel(c: Context) {
    const model = createModelFromRequest(await c.req.json());
    console.log("[modelController] Creating model:", model);

    const instance = await modelService.createModel(model);

    console.log("[modelController] Model created successfully:", instance);
    return c.json(instance);
}


async function listModels(c: Context) {
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);
    const vendorId = query.vendor_id ? parseInt(query.vendor_id, 10) : undefined;
    const result = await modelManager.listModels({
        vendorId: vendorId && !isNaN(vendorId) ? vendorId : undefined,
        keyword: query.keyword,
        pageSize,
        offset,
    });
    return c.json(createListResponse(result.list, result.total));
}


async function listLlmModels(c: Context) {
    const models = await modelManager.listEnabledModels();
    return c.json({
        object: "list",
        data: models,
    });
}


async function getModel(c: Context) {
    const id = c.req.param("id");
    const modelId = parseInt(id, 10);

    if (isNaN(modelId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const model = await modelManager.findById(modelId);

    if (!model) {
        throw new customError.NotFoundError("Model not found");
    }

    return c.json(model);
}

async function getModelsByIds(c: Context) {
    const body = await c.req.json();
    const ids = body.ids;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return c.json([]);
    }

    const idList = ids.map(id => parseInt(String(id), 10)).filter(id => !isNaN(id));
    if (idList.length === 0) {
        return c.json([]);
    }

    const models = await modelManager.getByIds(idList);
    return c.json(models);
}


// 模型路由测试：走真实网关路由 + failover（senderService.sendRequest），返回上游实际请求快照与上游响应。
// sender 在 inspect 模式下把最终命中的上游请求注入 c（upstreamRequestSnapshot），此处读出并组装成
// 与供应商直连测试一致的 VendorTestResponse，前端据此展示请求详情。
async function testModelRoute(c: Context) {
    const bodyJson = await c.req.json().catch(() => ({}));
    const modelName = (bodyJson as any).model;
    const formatRaw = (bodyJson as any).format || "openai";

    if (!modelName) {
        throw new customError.AppError("model is required");
    }
    if (![ApiFormat.OPENAI, ApiFormat.ANTHROPIC, ApiFormat.RESPONSES].includes(formatRaw)) {
        throw new customError.AppError("format must be one of openai, anthropic, responses");
    }
    const format = formatRaw as ApiFormat;

    // requireAdmin 中间件只设置了 user_type，这里从 token 解析完整用户（与 llmApiMiddleware 做法一致）
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const user = await userService.getUserByToken(token, c.env.ROOT_TOKEN);
    if (!user) {
        throw new customError.NotFoundError("User not found");
    }

    const modelConfig = await modelManager.getModel(modelName, true);
    if (!modelConfig) {
        return c.json({
            success: false,
            error: "model not found",
            url: null,
            request_method: "POST",
            request_headers: {},
            request_body: null,
        });
    }

    const body = buildTestRequestBody(format, modelName);
    const startTime = Date.now();

    let response: Response;
    try {
        response = await sender.sendRequest(c, user, modelConfig, format, body, { inspect: true });
    } catch (e: any) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        const snapshot = c.get("upstreamRequestSnapshot") as any;
        c.status(200);
        return c.json({
            success: false,
            status: typeof e?.status === "number" ? e.status : undefined,
            duration: Date.now() - startTime,
            url: snapshot?.url ?? null,
            converted_from:
                snapshot && snapshot.client_format !== snapshot.upstream_format ? snapshot.client_format : undefined,
            converted_to:
                snapshot && snapshot.client_format !== snapshot.upstream_format ? snapshot.upstream_format : undefined,
            proxy: snapshot?.proxy ?? null,
            request_method: "POST",
            request_headers: snapshot?.headers ?? {},
            request_body: snapshot?.body ? parseJsonLike(snapshot.body) : null,
            error: errorMessage,
        });
    }

    const responseText = await response.text();
    const snapshot = c.get("upstreamRequestSnapshot") as any;
    c.status(200);
    return c.json({
        success: response.ok,
        status: response.status,
        duration: Date.now() - startTime,
        url: snapshot?.url ?? null,
        converted_from:
            snapshot && snapshot.client_format !== snapshot.upstream_format ? snapshot.client_format : undefined,
        converted_to:
            snapshot && snapshot.client_format !== snapshot.upstream_format ? snapshot.upstream_format : undefined,
        proxy: snapshot?.proxy ?? null,
        request_method: "POST",
        request_headers: snapshot?.headers ?? {},
        request_body: snapshot?.body ? parseJsonLike(snapshot.body) : null,
        response: parseJsonLike(responseText),
    });
}


async function updateModel(c: Context) {
    const id = c.req.param("id");
    const modelId = parseInt(id, 10);

    if (isNaN(modelId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const model = createModelFromRequest(await c.req.json());
    model.id = modelId;
    console.log("[modelController] Updating model:", model);

    const updatedModel = await modelService.updateModel(model);

    if (!updatedModel) {
        throw new customError.NotFoundError("Model not found");
    }

    console.log("[modelController] Model updated successfully:", updatedModel);
    return c.json(updatedModel);
}


async function deleteModel(c: Context) {
    const id = c.req.param("id");
    const modelId = Number(id);

    if (!Number.isInteger(modelId) || modelId <= 0) {
        throw new customError.AppError("Invalid ID format");
    }

    const deleted = await modelManager.deleteModel(modelId);

    if (!deleted) {
        throw new customError.NotFoundError("Model not found");
    }

    return c.json({ success: true });
}

export default {
    createModel,
    listModels,
    listLlmModels,
    getModel,
    getModelsByIds,
    testModelRoute,
    updateModel,
    deleteModel,
};
