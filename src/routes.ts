import { Hono, MiddlewareHandler } from "hono";
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
}

const dbMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    await ormService.prepareDBConnection(c.env?.DB);
    await next();
};

const app = new Hono<{ Bindings: Env }>();

// 注册全局错误处理中间件
app.use("*", errorHandler);

// 注册数据库中间件
app.use("*", dbMiddleware);

// System
app.get("/", systemController.welcome);
app.get("/status.json", authMiddleware.requireAdmin, systemController.status);

// Vendor (需要管理员权限)
app.get("/vendor/list.json", authMiddleware.requireAdmin, vendorController.listVendors);
app.get("/vendor/:id", authMiddleware.requireAdmin, vendorController.getVendor);
app.post("/vendor/create.json", authMiddleware.requireAdmin, vendorController.createVendor);
app.put("/vendor/:id", authMiddleware.requireAdmin, vendorController.updateVendor);

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

// AI
app.post("/v1/chat/completions", gatewayController.chatCompletions);
app.post("/v1/messages", gatewayController.anthropicMessages);

export { app, Env };
export default app;
