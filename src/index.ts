import ormService from "./service/ormService";
import app from "./routes";

// 初始化云端配置
await ormService.init({ mode: "cloud" });

export default app;
