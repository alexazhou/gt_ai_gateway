import { Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiFormat, UserType } from "./constants";
import { SgUser } from "./model/sgUser";
import { SgModel } from "./model/sgModel";

import gatewayController from "./controller/gatewayController";
import modelController from "./controller/modelController";
import userController from "./controller/userController";
import vendorController from "./controller/vendorController";
import vendorModelController from "./controller/vendorModelController";
import recordController from "./controller/recordController";
import recordActivityController from "./controller/recordActivityController";
import systemController from "./controller/systemController";
import statsController from "./controller/statsController";
import balanceController from "./controller/balanceController";
import configController from "./controller/configController";
import clientConfigController from "./controller/clientConfigController";
import ruleController from "./controller/ruleController";
import tenantController from "./controller/tenantController";
import configService from "./service/configService";
import ruleService from "./service/ruleService";
import tenantService from "./service/tenantService";
import ormService from "./service/ormService";
import objectStorageService from "./service/objectStorageService";
import authMiddleware from "./middleware/authMiddleware";
import llmApiMiddleware from "./middleware/llmApiMiddleware";
import tenantScopeMiddleware, { TenantScope } from "./middleware/tenantScopeMiddleware";
import corsMiddleware from "./middleware/corsMiddleware";
import customError from "./customError";

interface Env {
    DB: D1Database;
    ROOT_TOKEN: string;
    ASSETS?: Fetcher;
    OBJECT_BUCKET?: R2Bucket;
}

type Variables = {
    user_type: UserType;
    api_format?: ApiFormat;
    user?: SgUser;
    modelConfig?: SgModel;
    requestBody?: string;
    tenantScope?: TenantScope;
};

const dbMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    await ormService.prepareDBConnection(c.env?.DB);
    // Inject the per-request R2 bucket binding for object storage (worker mode).
    // In node mode c.env.OBJECT_BUCKET is absent -> null -> objectStorageService
    // falls back to the storage_record table.
    objectStorageService.setR2Bucket(c.env?.OBJECT_BUCKET ?? null);
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

// 租户业务路由统一走 requireTenantAdmin（鉴权 + 注入 user/tenantScope；SPA 前端路由直接放行）。
// 全局控制面（/tenant、/config.json、/client-config/*、/status.json、/update.json）与 LLM API 不走这里。
const TENANT_SCOPED_PREFIXES = [
    "/user/*",
    "/model/*",
    "/vendor/*",
    "/vendor-model/*",
    "/balance/recharge/*",
    "/record/*",
    "/stats/*",
    "/rule/*",
];
for (const prefix of TENANT_SCOPED_PREFIXES) {
    app.use(prefix, tenantScopeMiddleware.requireTenantAdmin);
}

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
        // 限流拒绝：附加 Retry-After 头（令牌桶可精确计算补足 1 个令牌的等待秒数，见 rateLimitService）
        if (error.code === "rate_limit_error") {
            const retryAfter = (error as unknown as { retryAfterSeconds?: number }).retryAfterSeconds ?? 60;
            c.header("Retry-After", String(retryAfter));
        }
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

// Tenant (root 专用；租户管理写操作需多租户功能开关开启)
// 注：detail 路由用裸 /tenant/:id（与 /vendor/:id、/model/:id 一致）；Hono 对 :id.json 的
// 参数解析有缺陷（param("id") 取不到值），故不加 .json 后缀
app.get("/tenant.json", authMiddleware.requireAdmin, tenantController.listTenants);
app.post("/tenant.json", authMiddleware.requireAdmin, tenantController.createTenant);
app.get("/tenant/:id", authMiddleware.requireAdmin, tenantController.getTenant);
app.put("/tenant/:id", authMiddleware.requireAdmin, tenantController.updateTenant);
app.delete("/tenant/:id", authMiddleware.requireAdmin, tenantController.deleteTenant);

// Rule (需要管理员权限)
app.get("/rule/list.json", authMiddleware.requireAdmin, ruleController.listRules);
app.get("/rule/:id", authMiddleware.requireAdmin, ruleController.getRule);
app.post("/rule/create.json", authMiddleware.requireAdmin, ruleController.createRule);
app.put("/rule/:id", authMiddleware.requireAdmin, ruleController.updateRule);
app.delete("/rule/:id", authMiddleware.requireAdmin, ruleController.deleteRule);

// Model (需要管理员权限)
app.post("/model/create.json", authMiddleware.requireAdmin, modelController.createModel);
app.post("/model/route-test.json", authMiddleware.requireAdmin, modelController.testModelRoute);
app.get("/model/list.json", authMiddleware.requireAdmin, modelController.listModels);
app.post("/model/batch.json", authMiddleware.requireAdmin, modelController.getModelsByIds);
app.get("/model/:id", authMiddleware.requireAdmin, modelController.getModel);
app.put("/model/:id", authMiddleware.requireAdmin, modelController.updateModel);
app.delete("/model/:id", authMiddleware.requireAdmin, modelController.deleteModel);

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
app.post("/record/recover-orphans.json", authMiddleware.requireAdmin, recordController.recoverOrphans);
app.get("/record/:id", authMiddleware.requireAdmin, recordController.getRecord);
app.delete("/record/clear-payload", authMiddleware.requireAdmin, recordController.clearPayload);
app.delete("/record/clear-all", authMiddleware.requireAdmin, recordController.clearAll);
app.delete("/record/:id", authMiddleware.requireAdmin, recordController.deleteRecord);

// Record Activity (需要管理员权限，独立控制器 recordActivityController)
app.get("/record/:id/activity.json", authMiddleware.requireAdmin, recordActivityController.getRecordActivity);

// Stats (需要管理员权限)
app.get("/stats/dashboard.json", authMiddleware.requireAdmin, statsController.dashboardStats);
app.get("/stats/recent.json", authMiddleware.requireAdmin, statsController.recentRecords);

// AI endpoints (no auth middleware, using custom llmApiAuth)
app.get("/llm/v1/models", llmApiMiddleware.requireLlmModelsAuth, modelController.listLlmModels);
app.post("/llm/v1/chat/completions", llmApiMiddleware.requireLlmRequestContext(ApiFormat.OPENAI), gatewayController.chatCompletions);
app.post("/llm/v1/messages", llmApiMiddleware.requireLlmRequestContext(ApiFormat.ANTHROPIC), gatewayController.anthropicMessages);
app.post("/llm/v1/responses", llmApiMiddleware.requireLlmRequestContext(ApiFormat.RESPONSES), gatewayController.responsesApi);

// Test endpoints
app.delete("/test/cache/clear", async (c) => {
    // Only allow in test mode
    const isTestMode = process.env.TEST_MODE || (c.env as any)?.TEST_MODE;
    if (!isTestMode) {
        return c.notFound();
    }
    configService.clearCache();
    ruleService.invalidateCache();
    // 测试清表后 main 租户 id 可能变化（SQLite AUTOINCREMENT 不重置），须清 tenantService 缓存
    tenantService.clearMainTenantCache();
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
