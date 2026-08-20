# V1.8: 多上游路由、对象存储与高精度计费 - 产品文档

## 目标

这是当前迭代的主版本，围绕四块核心能力：**一个对外模型可路由到多个上游**、**请求明细落库与存储解耦**、**计费精度彻底 Decimal 化**、**请求活动全生命周期可追踪**。

## 功能特性

### 多上游路由

- **三种路由模式**：`single`（单上游）、`load_balance`（负载均衡）、`first_available`（首个可用）
- **负载均衡策略**：按用户随机（同用户路由稳定）或按请求随机
- **健康状态检查**：上游失败进入冷却（in-memory），仅「上游自身故障」（5xx / 402 / 网络不可达）触发，4xx 不冷却
- **故障转移（failover）**：任何非成功响应自动切换到下一个可用上游；所有上游耗尽后返回最后一次带路由上下文的错误
- **模型配置 UI**：前端可视化配置上游列表、路由模式与负载策略

### 对象存储

- **请求 / 响应 payload 解耦**：record 表不再存 request_data / response_data，改存对象存储（`storage_record` 表 / Cloudflare R2）
- **存储位置选择**：`record_payload_storage` 支持 database / r2 / auto，`record_payload_enabled` 开关
- **兼容回退**：R2 不可用时自动回退数据库，读取时双位置兜底

### 高精度计费

- **整数微元存储**：用户余额改为整数微元（1 元 = 1,000,000 微元），消除浮点误差
- **百万 Token 计价**：价格以元/百万 Token 为单位
- **免费模型**：价格为 0 的模型不启用计费，跳过余额检查
- **负余额策略**：请求前预检拦截负余额（免费模型除外），请求完成后允许扣成负余额

### 请求活动时间线

- **一条请求一条记录**：record 记录请求生命周期
- **request_activity 活动日志**：按 record_id 追加阶段活动（upsert），覆盖请求成功 / 中断 / 上游错误 / 流式不完整等
- **first_token_latency**：非流式请求记录整体响应耗时

### 协议与供应商

- **协议转换增强**：Responses ↔ OpenAI 双向转换、thinking block ↔ reasoning_content 映射、Anthropic adaptive thinking（xhigh/max/ultracode effort 选项）
- **供应商能力**：`auth_mode`（API Key / Bearer Token）、HTTP / SOCKS5 代理、`skip_tls_verify`
- **LLM models 端点**：对外提供模型列表查询

### 运营与工程

- 模块开关：计费模块、API playground 模块可配置启用
- 日志轮转（大小 + 数量）、自动更新检测、请求记录删除（单条 / 批量）
- Cloudflare 自动部署完善（自定义 ROOT_TOKEN、R2 bucket 自动创建）
- 开源许可证由 GPL v2 改为 MIT + 署名条款

## 验收标准

- [ ] 模型可配置多个上游，按策略路由，上游失败自动切换
- [ ] payload 存对象存储后记录列表仍能正常展示（大 payload 不拖慢列表）
- [ ] 余额 / 计费以整数微元计算，免费模型不扣费、负余额不误拦截
- [ ] 一次请求能在记录 + 活动时间线中还原完整生命周期
- [ ] 计费模块关闭后，用户列表不显示余额相关功能

## 相关文档

- [技术文档](./step2_technical.md)
- [开发任务表](./step3_tasks.md)
- 专项设计：[model_multi_upstream_routing_design.md](./model_multi_upstream_routing_design.md)、[request_record_and_activity_design.md](./request_record_and_activity_design.md)、[upstream_failover_last_error_design.md](./upstream_failover_last_error_design.md)
