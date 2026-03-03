import { Hono, MiddlewareHandler } from "hono";
import gatewayController from "./controller/gatewayController";
import modelController from "./controller/modelController";
import userController from "./controller/userController";
import vendorController from "./controller/vendorController";
import recordController from "./controller/recordController";
import systemController from "./controller/systemController";
import ormService from "./service/ormService";

interface Env {
    DB: D1Database;
}

const dbMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    await ormService.prepareDBConnection(c.env?.DB);
    await next();
};

const app = new Hono<{ Bindings: Env }>();

// 注册数据库中间件
app.use("*", dbMiddleware);

// System
app.get("/", systemController.welcome);

// Model
app.post("/model/create.json", modelController.createModel);
app.get("/model/list.json", modelController.listModels);
app.get("/model/:id", modelController.getModel);

// User
app.get("/user/list.json", userController.listUsers);
app.get("/user/:id", userController.getUser);
app.post("/user/create.json", userController.createUser);

// Vendor
app.get("/vendor/list.json", vendorController.listVendors);
app.get("/vendor/:id", vendorController.getVendor);
app.post("/vendor/create.json", vendorController.createVendor);

// Record
app.get("/record/list.json", recordController.listRecords);
app.get("/record/latest.json", recordController.latestRecords);
app.get("/record/:id", recordController.getRecord);

// AI
app.post("/v1/chat/completions", gatewayController.chatCompletions);
app.post("/v1/messages", gatewayController.anthropicMessages);

export { app, Env };
export default app;
