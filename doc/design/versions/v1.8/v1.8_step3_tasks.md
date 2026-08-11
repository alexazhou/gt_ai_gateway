# V1.8: 多上游路由、对象存储与高精度计费 - 开发任务表

## 任务概览

V1.8 是当前进行中的版本（当前发布线 v1.8.x）。以下任务按 git 提交提炼，覆盖已完成与待收尾两部分。共 7 组任务，按依赖排序。

> 状态标记：`[x]` 已完成，`[ ]` 待完成 / 待验证。

---

## 任务列表

### 任务 1: 多上游路由与负载均衡

**描述**: 模型支持多个上游，实现路由模式、负载均衡策略、健康检查与故障转移。

**依赖**: 无

**核心文件**:
- `src/service/routingService/core.ts`、`routingService/routingStrategy/*`
- `src/service/upstreamHealthService.ts`
- `src/service/senderService.ts`
- `src/model/sgModel.ts`（ModelRoutingConfig）

**子任务**:
- [x] 支持 multi-upstream model routing，移除旧 model 直连 vendor 字段
- [x] SINGLE / LOAD_BALANCE / FIRST_AVAILABLE 三种路由模式
- [x] 负载均衡按用户 / 按请求随机，路由过滤下沉到策略类
- [x] 健康状态检查（in-memory 冷却）与故障转移（failover）
- [x] failover 耗尽返回带路由上下文的最后一次错误
- [x] 模型路由配置前端 UI
- [x] 多上游路由测试覆盖
- [ ] 路由 / 冷却边界情况在真实上游下回归验证

**验收标准**:
- 上游 A 故障时请求自动切换到上游 B，成功返回
- 同用户负载均衡路由稳定（按用户策略）

### 任务 2: 请求记录与活动时间线

**描述**: 一次请求一条记录 + request_activity 活动日志。

**依赖**: 无

**核心文件**:
- `src/model/sgRequestActivity.ts`
- `src/service/requestActivityService.ts`
- `src/service/recordService.ts`
- `src/service/responseHandlerService.ts`

**子任务**:
- [x] request_activity 表：id 自增主键、record_id 唯一索引
- [x] append（upsert by record_id，best-effort）与 getByRecordId
- [x] 非流式请求 first_token_latency 记录整体响应耗时
- [x] 响应处理各阶段（成功 / 中断 / 上游错误 / 流式不完整）写入活动
- [x] 前端记录详情展示活动时间线

**验收标准**:
- 一次请求能在活动时间线中还原完整生命周期
- 活动日志写入失败不影响请求结果

### 任务 3: 高精度计费 Decimal 化

**描述**: 余额整数微元存储，百万 Token 计价，免费模型与负余额策略。

**依赖**: 无

**核心文件**:
- `resource/migrate/migrate_0028.sql`（balance → balance_units）
- `src/service/userService.ts`（toUnits / adjustBalance / deductBalance / checkBalance）
- `src/model/sgModel.ts`（prices / validatePrices / hasBilling）

**子任务**:
- [x] 余额迁移为整数微元存储（1 元 = 1,000,000 微元）
- [x] 计价单位改为百万 Token（prices JSON：input / output / cache_read）
- [x] 价格为 0 / 未设置的模型不启用计费，负余额不拦截
- [x] 请求前预检负余额，完成时允许扣成负余额
- [x] 前端如实显示微小欠费（避免负余额显示成 0.00）
- [x] 计费模块开关（MODULE_BILLING_ENABLED）隐藏余额相关界面
- [ ] 金额换算 / 边界（超小余额、极大余额）回归测试

**验收标准**:
- 余额加减均为整数运算，无浮点漂移
- 免费模型调用不扣费，负余额用户（非免费模型）请求被拦截

### 任务 4: 对象存储（payload 解耦）

**描述**: record 的 request / response payload 迁移到 storage_record / R2。

**依赖**: 无

**核心文件**:
- `src/service/objectStorageService.ts`
- `src/service/recordService.ts`（create / update / attachPayload）
- `src/model/sgStorageRecord.ts`
- Cloudflare R2 binding + 自动建桶

**子任务**:
- [x] objectStorageService 表操作 + R2 双位置读写 / 回退
- [x] 迁移脚本把旧 record payload 复制到 storage_record
- [x] recordService 读写走对象存储，列表接口排除大 payload 字段
- [x] record_payload_enabled / record_payload_storage 开关与位置选择
- [x] R2 不可用时回退数据库，读取双位置兜底
- [x] 前端无 payload 时提示
- [x] payload 清理（删除记录时同步清理存储）
- [ ] R2 生产环境端到端验证

**验收标准**:
- 记录列表不因大 payload 而缓慢
- 关闭 payload 记录后仍可正常转发

### 任务 5: 协议转换增强

**描述**: Responses ↔ OpenAI 双向、thinking ↔ reasoning_content、Anthropic adaptive thinking。

**依赖**: 无

**核心文件**:
- `src/util/protocolConverter/*`
- `src/util/accumulator/*`

**子任务**:
- [x] Responses ↔ OpenAI 双向转换
- [x] thinking block ↔ reasoning_content 映射（双向）
- [x] Anthropic adaptive thinking + output_config.effort（xhigh / max / ultracode）
- [x] 流式完成 / 合并 finish_reason+usage / 连续工具调用等边界修复
- [x] 转换器 client-server 风格重构，转换器测试拆分

**验收标准**:
- 各协议互转后功能等价、token 统计正确

### 任务 6: 供应商能力增强

**描述**: auth_mode、HTTP / SOCKS5 代理、skip_tls_verify。

**依赖**: 无

**核心文件**:
- `src/model/sgVendor.ts`（SgVendorConfig cast）
- `src/service/vendorTestService.ts`
- `src/util/fetchUtil.ts`

**子任务**:
- [x] vendor.config 增加 auth_mode（API Key / Bearer Token，默认 bearer）
- [x] HTTP / SOCKS5 代理支持（undici 动态导入兼容 Worker）
- [x] skip_tls_verify 支持自签证书环境
- [x] vendor 测试展示实际请求详情（请求 / 响应 / 代理信息）
- [x] 代理与 TLS 的 mock 集成测试

**验收标准**:
- 上游走代理、自签证书环境下可正常连通与测试

### 任务 7: 部署 / 运营 / 开源

**描述**: Cloudflare 自动部署、日志轮转、模块开关、许可证调整。

**依赖**: 无

**核心文件**:
- `.github/workflows/`（cloudflare / tests / tauri）
- `src/service/logger.ts`、`configService.ts`
- `package.json`（许可证）

**子任务**:
- [x] Cloudflare 一键部署完善（自定义 ROOT_TOKEN、R2 bucket 自动创建、数据库 ID 注入）
- [x] 日志轮转（大小 + 数量）
- [x] 模块开关：计费、API playground
- [x] 自动更新检测、LLM models 端点、模型删除、记录删除
- [x] 许可证 GPL v2 → MIT + 署名条款
- [x] 预提交钩子：版本一致性校验、提交信息检查

**验收标准**:
- 新 fork 仓库可一键部署到 Cloudflare
- 日志文件大小受控

---

## 总体验收

- [ ] 全量后端测试（node + worker 模式）通过
- [ ] TypeScript 静态类型检查通过
- [ ] 前端构建通过
- [ ] 版本号在 package.json / frontend / tauri 三处一致
