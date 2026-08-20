# V1.5: Tauri 桌面与协议转换 - 技术文档

## 架构概览

V1.5 的核心是两条主线：**桌面端运行形态**与**协议转换引擎**，均以不侵入网关核心转发链路为原则。

## Tauri 桌面端

### 运行形态

- **侧车（sidecar）**：桌面应用通过 PTY（libc 直接 PTY）启动 `ai-gateway-backend` 子进程，桌面退出时子进程自动退出
- **自动登录**：桌面模式首次启动自动生成 root token 写入环境并自动登录，等待后端就绪后注入
- **WebView + 本地前端**：内置前端构建产物，通过 `tauri://localhost` 访问；CSP 适配、跨域白名单
- **托盘与生命周期**：托盘图标（macOS template 模式）、隐藏原生标题栏、窗口关闭隐藏、dock 图标点击重建窗口

### 关键适配

- `DESKTOP_MODE` / `--api-only` 参数控制后端是否托管前端静态资源
- `fsUtil` 统一 Node / Tauri 文件系统差异
- 端口约定：桌面应用模式 6722，源码模式 8720

## 协议转换引擎

### 设计

- `ConverterFactory` 按「客户端格式 × 上游格式」创建 converter，转换器只负责格式映射
- 各协议格式解析（chat / responses / anthropic）下沉到 `senderService`，usage 统一经 `normalizeUsage` 提取
- 转换在转发路径中对请求体与响应流分别处理；流式响应经累加器 + converter 重写 chunk 后转发

### 转换方向

| 客户端协议 | 上游协议 | 说明 |
|---|---|---|
| OpenAI | Anthropic / Responses | chat → messages；thinking block ↔ reasoning_content |
| Anthropic | OpenAI / Responses | system 拆分、工具定义映射 |
| Responses | OpenAI / Anthropic | 双向，V1.8 补全 |

## 供应商模型管理

- 新增 vendor_model 的 fetch / sync / 测试接口
- `vendor_model_id` 记录在 model 上游配置与 record 表，实现上游模型名替换
- vendor 预置 URL 由后端 `vendorDefaultUrls` 下发，前端按 vendor type 加载

## 相关文档

- [产品文档](./step1_product.md)
- [Tauri 开发手册](../../dev/TauriDevManual.md)
- [协议转换说明](../../usage/ProtocolConversion.md)
