import { Hono, MiddlewareHandler, HTTPException } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "path";
import gatewayController from "./controller/gatewayController";
import modelController from "./controller/modelController";
import userController from "./controller/userController";
import vendorController from "./controller/vendorController";
import recordController from "./controller/recordController";
import systemController from "./controller/systemController";
import ormService from "./service/ormService";
import authMiddleware from "./middleware/authMiddleware";
import errorHandler from "./util/errorHandler";

interface Env {
    DB: D1Database;
    ROOT_TOKEN: string;
}

const dbMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    await ormService.prepareDBConnection(c.env?.DB);
    await next();
};

const app = new Hono<{ Bindings: Env }>();

// 注册数据库中间件（最前面）
app.use("*", dbMiddleware);

// 注册全局错误处理
app.onError((err, c) => {
    const error = err as Record<string, unknown>;
    const statusCode = error.statusCode as number;
    const message = error.message as string;

    if (statusCode && message) {
        return c.json(
            {
                error: message,
                code: error.code as string | undefined,
            },
            statusCode,
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
app.get("/vendor/:id", authMiddleware.requireAdmin, vendorController.getVendor);
app.post("/vendor/create.json", authMiddleware.requireAdmin, vendorController.createVendor);
app.put("/vendor/:id", authMiddleware.requireAdmin, vendorController.updateVendor);
app.delete("/vendor/:id", authMiddleware.requireAdmin, vendorController.deleteVendor);

// Model (需要管理员权限)
app.post("/model/create.json", authMiddleware.requireAdmin, modelController.createModel);
app.get("/model/list.json", authMiddleware.requireAdmin, modelController.listModels);
app.get("/model/:id", authMiddleware.requireAdmin, modelController.getModel);
app.put("/model/:id", authMiddleware.requireAdmin, modelController.updateModel);

// User (需要管理员权限)
app.get("/user/list.json", authMiddleware.requireAdmin, userController.listUsers);
app.get("/user/:id", authMiddleware.requireAdmin, userController.getUser);
app.post("/user/create.json", authMiddleware.requireAdmin, userController.createUser);

// Record (需要管理员权限)
app.get("/record/list.json", authMiddleware.requireAdmin, recordController.listRecords);
app.get("/record/latest.json", authMiddleware.requireAdmin, recordController.latestRecords);
app.get("/record/:id", authMiddleware.requireAdmin, recordController.getRecord);

// AI endpoints (no auth middleware)
app.post("/v1/chat/completions", gatewayController.chatCompletions);
app.post("/v1/messages", gatewayController.anthropicMessages);

// Static file serving (frontend)
const distPath = join(process.cwd(), "frontend", "dist");
app.use("/assets/*", serveStatic({ root: distPath }));
app.use("/*.svg", serveStatic({ root: distPath }));

// SPA fallback - return index.html for all non-API routes
app.get("*", async (c) => {
    const url = new URL(c.req.url);

    // Skip API routes
    if (url.pathname.startsWith("/v1/") || url.pathname.includes(".json")) {
        return c.json({ error: "Not found" }, 404);
    }

    // Return index.html for SPA routing
    return serveStatic({ root: distPath, path: "/index.html" })(c);
});

export { app, Env };
export default app;
