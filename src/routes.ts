import { Hono, MiddlewareHandler, HTTPException } from "hono";
import { logger } from "hono/logger";
import { join } from "path";
import { readFileSync } from "fs";
import gatewayController from "./controller/gatewayController";
import modelController from "./controller/modelController";
import userController from "./controller/userController";
import vendorController from "./controller/vendorController";
import vendorModelController from "./controller/vendorModelController";
import recordController from "./controller/recordController";
import systemController from "./controller/systemController";
import statsController from "./controller/statsController";
import balanceController from "./controller/balanceController";
import ormService from "./service/ormService";
import authMiddleware from "./middleware/authMiddleware";
import corsMiddleware from "./middleware/corsMiddleware";
import customError from "./util/customError";

interface Env {
    DB: D1Database;
    ROOT_TOKEN: string;
    ASSETS: Fetcher;
}

type Variables = {
    user_type: string;
};

const dbMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    await ormService.prepareDBConnection(c.env?.DB);
    await next();
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS 中间件（放行 Tauri WebView 及本地开发请求）
app.use("*", corsMiddleware.allowCors);

// 注册日志中间件
app.use("*", logger());

// 注册数据库中间件（最前面）
app.use("*", dbMiddleware);

// 注册全局错误处理
app.onError((err, c) => {
    const error = err as Record<string, unknown>;
    const statusCode = error.statusCode as number || 500;
    const message = error.message as string || String(err);

    // 记录错误日志
    console.error(`[Error] ${c.req.method} ${c.req.path}:`, err);

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

// Vendor (需要管理员权限)
app.get("/vendor/list.json", authMiddleware.requireAdmin, vendorController.listVendors);
app.post("/vendor/batch.json", authMiddleware.requireAdmin, vendorController.getVendorsByIds);
app.post("/vendor/create.json", authMiddleware.requireAdmin, vendorController.createVendor);
app.post("/vendor-model/batch.json", authMiddleware.requireAdmin, vendorModelController.getVendorModelsByIds);
app.get("/vendor/:id/model/list.json", authMiddleware.requireAdmin, vendorModelController.listVendorModels);
app.get("/vendor/:id/model/fetch.json", authMiddleware.requireAdmin, vendorModelController.fetchVendorModels);
app.post("/vendor/:id/model/sync.json", authMiddleware.requireAdmin, vendorModelController.syncVendorModels);
app.post("/vendor/:id/model/add.json", authMiddleware.requireAdmin, vendorModelController.addVendorModel);
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

// AI endpoints (no auth middleware)
app.post("/llm/v1/chat/completions", gatewayController.chatCompletions);
app.post("/llm/v1/messages", gatewayController.anthropicMessages);
app.post("/llm/v1/responses", gatewayController.responsesApi);

// SPA fallback - serve index.html for all non-API routes
// This handles frontend routes like /dashboard, /vendor, etc.
app.get("*", async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // Let static assets pass through to static file middleware (node mode)
    if (pathname.startsWith("/assets/") ||
        pathname.endsWith(".svg") ||
        pathname.endsWith(".png") ||
        pathname.endsWith(".jpg") ||
        pathname.endsWith(".ico") ||
        pathname.endsWith(".woff") ||
        pathname.endsWith(".woff2") ||
        pathname.endsWith(".ttf")) {
        return next();
    }

    // API routes should return 404
    if (pathname.startsWith("/v1/") || pathname.includes(".json")) {
        return c.notFound();
    }

    // Try to serve from Assets binding first (worker mode)
    if (c.env.ASSETS) {
        try {
            const response = await c.env.ASSETS.fetch(new Request("https://example.com/index.html"));
            if (response.ok) {
                const html = await response.text();
                return c.html(html, 200);
            }
        } catch (e) {
            // Fall through to serve index.html directly
        }
    }

    // Serve index.html directly (node mode or fallback)
    try {
        const distPath = join(process.cwd(), "frontend", "dist");
        const indexHtml = readFileSync(join(distPath, "index.html"), "utf-8");
        return c.html(indexHtml, 200);
    } catch (e) {
        return c.notFound();
    }
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
