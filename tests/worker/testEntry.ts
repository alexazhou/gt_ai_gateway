import ormService from "../../src/service/ormService";
import { buildApp } from "../../src/app";
import { RunMode } from "../../src/constants";
import { registerTestRoutes } from "./testRoutes";

// 与生产入口同一套初始化；差别只在于额外挂载测试路由（`/test/*`）
await ormService.init({ mode: RunMode.WORKER });

export default buildApp(registerTestRoutes);
