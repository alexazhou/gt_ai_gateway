import { Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiFormat, UserType } from "./constants";
import { SgUser } from "./model/sgUser";
import { SgModel } from "./model/sgModel";
import { SgVendor } from "./model/sgVendor";

import gatewayController from "./controller/gatewayController";
import modelController from "./controller/modelController";
import userController from "./controller/userController";
import vendorController from "./controller/vendorController";
import vendorModelController from "./controller/vendorModelController";
import recordController from "./controller/recordController";
import systemController from "./controller/systemController";
import statsController from "./controller/statsController";
import balanceController from "./controller/balanceController";
import configController from "./controller/configController";
import clientConfigController from "./controller/clientConfigController";
import configService from "./service/configService";
import ormService from "./service/ormService";
import authMiddleware from "./middleware/authMiddleware";
import llmApiMiddleware from "./middleware/llmApiMiddleware";
import corsMiddleware from "./middleware/corsMiddleware";
import customError from "./util/customError";

interface Env {
    DB: D1Database;
    ROOT_TOKEN: string;
    ASSETS?: Fetcher;
}

type Variables = {
    user_type: UserType;
    api_format?: ApiFormat;
    user?: SgUser;
    modelConfig?: SgModel;
    vendor?: SgVendor;
    requestBody?: string;
};

const dbMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    await ormService.prepareDBConnection(c.env?.DB);
    await next();
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS 中间件（放行 Tauri WebView 及本地开发请求）
app.use("*", corsMiddleware.allowCors);

// 注册日志中间件
app.use("*", async (c, next) => {
    const start = Date.now();
    const { method, url } = c.req;
    const path = url.slice(url.indexOf("/", 8));
    console.log(`↑ ${method} ${path}`);
    await next();
    console.log(`↓ ${method} ${path} ${c.res.status} ${Date.now() - start}ms`);
});

// 注册数据库中间件（最前面）
app.use("*", dbMiddleware);

// 注册全局错误处理
app.onError((err, c) => {
    const error = err as unknown as Record<string, unknown>;
    const statusCode = error.statusCode as number || 500;
    const message = error.message as string || String(err);

    // 记录错误日志
    console.error(`[Error] ${c.req.method} ${c.req.path}:`, err);

    const apiFormat = c.get("api_format");
    if (apiFormat) {
        const formatted = customError.buildLlmErrorResponse(err as any, apiFormat);
        return c.json(formatted, statusCode as any);
    }

    if (error.statusCode && message) {
        return c.json(
            {
                error: message,
                code: error.code as string | undefined,
            },
            statusCode as any,
        );
    }

    // 处理未知错误
    return c.json(
        {
            error: "Internal server error",
            message: String(err),
        },
        500,
    );
});

// System
app.get("/welcome", systemController.welcome);
app.get("/status.json", authMiddleware.requireAdmin, systemController.status);
app.get("/update.json", authMiddleware.requireAdmin, systemController.checkUpdate);
app.get("/config.json", authMiddleware.requireAdmin, configController.getConfig);
app.put("/config.json", authMiddleware.requireAdmin, configController.updateConfig);
app.get("/client-config/status.json", authMiddleware.requireAdmin, clientConfigController.status);
app.get("/client-config/local.json", authMiddleware.requireAdmin, clientConfigController.readLocal);
app.post("/client-config/create.json", authMiddleware.requireAdmin, clientConfigController.create);
app.post("/client-config/backup.json", authMiddleware.requireAdmin, clientConfigController.backup);
app.post("/client-config/backup/rename.json", authMiddleware.requireAdmin, clientConfigController.renameBackup);
app.post("/client-config/backup/delete.json", authMiddleware.requireAdmin, clientConfigController.deleteBackup);
app.post("/client-config/backup/update.json", authMiddleware.requireAdmin, clientConfigController.updateBackup);
app.post("/client-config/apply.json", authMiddleware.requireAdmin, clientConfigController.apply);
app.post("/client-config/sync-from-local.json", authMiddleware.requireAdmin, clientConfigController.syncFromLocal);

// Vendor (需要管理员权限)
app.get("/vendor/preset-urls.json", authMiddleware.requireAdmin, vendorController.getPresetUrls);
app.get("/vendor/list.json", authMiddleware.requireAdmin, vendorController.listVendors);
app.post("/vendor/batch.json", authMiddleware.requireAdmin, vendorController.getVendorsByIds);
app.post("/vendor/create.json", authMiddleware.requireAdmin, vendorController.createVendor);
app.post("/vendor-model/batch.json", authMiddleware.requireAdmin, vendorModelController.getVendorModelsByIds);
app.get("/vendor/:id/model/list.json", authMiddleware.requireAdmin, vendorModelController.listVendorModels);
app.get("/vendor/:id/model/fetch.json", authMiddleware.requireAdmin, vendorModelController.fetchVendorModels);
app.post("/vendor/:id/model/sync.json", authMiddleware.requireAdmin, vendorModelController.syncVendorModels);
app.post("/vendor/:id/model/add.json", authMiddleware.requireAdmin, vendorModelController.addVendorModel);
app.put("/vendor/:id/model/:modelId", authMiddleware.requireAdmin, vendorModelController.updateVendorModel);
app.delete("/vendor/:id/model/:modelId", authMiddleware.requireAdmin, vendorModelController.deleteVendorModel);
app.get("/vendor/:id", authMiddleware.requireAdmin, vendorController.getVendor);
app.post("/vendor/:id/test.json", authMiddleware.requireAdmin, vendorController.testVendor);
app.put("/vendor/:id", authMiddleware.requireAdmin, vendorController.updateVendor);
app.delete("/vendor/:id", authMiddleware.requireAdmin, vendorController.deleteVendor);

// Model (需要管理员权限)
app.post("/model/create.json", authMiddleware.requireAdmin, modelController.createModel);
app.get("/model/list.json", authMiddleware.requireAdmin, modelController.listModels);
app.post("/model/batch.json", authMiddleware.requireAdmin, modelController.getModelsByIds);
app.get("/model/:id", authMiddleware.requireAdmin, modelController.getModel);
app.put("/model/:id", authMiddleware.requireAdmin, modelController.updateModel);

// User (需要管理员权限)
app.get("/user/list.json", authMiddleware.requireAdmin, userController.listUsers);
app.post("/user/batch.json", authMiddleware.requireAdmin, userController.getUsersByIds);
app.get("/user/:id", authMiddleware.requireAdmin, userController.getUser);
app.post("/user/create.json", authMiddleware.requireAdmin, userController.createUser);
app.put("/user/:id", authMiddleware.requireAdmin, userController.updateUser);
app.post("/user/:id/balance/adjust.json", authMiddleware.requireAdmin, userController.adjustBalance);

// Balance (需要管理员权限)
app.get("/balance/recharge/list.json", authMiddleware.requireAdmin, balanceController.listRechargeRecords);
app.get("/balance/recharge/:id", authMiddleware.requireAdmin, balanceController.getRechargeRecord);

// Record (需要管理员权限)
app.get("/record/list.json", authMiddleware.requireAdmin, recordController.listRecords);
app.get("/record/latest.json", authMiddleware.requireAdmin, recordController.latestRecords);
app.get("/record/:id", authMiddleware.requireAdmin, recordController.getRecord);

// Stats (需要管理员权限)
app.get("/stats/dashboard.json", authMiddleware.requireAdmin, statsController.dashboardStats);
app.get("/stats/recent.json", authMiddleware.requireAdmin, statsController.recentRecords);

// AI endpoints (no auth middleware, using custom llmApiAuth)
app.post("/llm/v1/chat/completions", llmApiMiddleware.requireLlmAuth(ApiFormat.OPENAI), gatewayController.chatCompletions);
app.post("/llm/v1/messages", llmApiMiddleware.requireLlmAuth(ApiFormat.ANTHROPIC), gatewayController.anthropicMessages);
app.post("/llm/v1/responses", llmApiMiddleware.requireLlmAuth(ApiFormat.RESPONSES), gatewayController.responsesApi);

// Test endpoints
app.delete("/test/cache/clear", async (c) => {
    // Only allow in test mode
    const isTestMode = process.env.TEST_MODE || (c.env as any)?.TEST_MODE;
    if (!isTestMode) {
        return c.notFound();
    }
    configService.clearCache();
    return c.json({ success: true });
});


// Custom 404 handler for API routes
app.notFound((c) => {
    // Return JSON error for API routes
    if (c.req.path.startsWith("/v1/") || c.req.path.includes(".json")) {
        return c.json({ error: "Not found" }, 404);
    }
    // Default 404 for non-API routes
    return c.text("404 Not Found", 404);
});

export { app, Env };
export default app;
