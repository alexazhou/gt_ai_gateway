import ormService from "./service/ormService";
import { buildApp } from "./app";
import { RunMode } from "./constants";

// 初始化云端配置
await ormService.init({ mode: RunMode.WORKER });

export default buildApp();
