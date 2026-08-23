# 多租户隔离（Tenant）- 开发任务表

> 状态：规划中（尚未实施）

## 任务概览

任务按依赖排序：先建租户基础实体与迁移（含功能开关），再做租户感知的查询过滤，然后接入 LLM 调用链路，实现模型共享语义，最后补前端租户化与测试回归。共 6 组任务（任务 1 - 4 为后端，任务 5 为前端，任务 6 为测试）。

> 状态标记：`[x]` 已完成，`[ ]` 待完成 / 待验证。

---

## 任务列表

### 任务 1: tenant 基础实体与迁移

**描述**: 建立 `tenant` 表、`SgTenant` 模型、`tenantManager` / `tenantService` / `tenantController`，引入 `main` 主租户与功能开关，完成迁移与存量回填。

**依赖**: 无

**核心文件**:
- `resource/migrate/migrate_0032/`（迁移目录，内含 `mysql.sql` + `sqlite.sql`；实施时须以当前最后一个迁移编号为准，当前为 `migrate_0031`）
- `src/model/sgTenant.ts`
- `src/model/sgRule.ts`
- `src/model/sgRecord.ts`
- `src/model/sgRechargeRecord.ts`
- `src/manager/tenantManager.ts`
- `src/service/tenantService.ts`
- `src/controller/tenantController.ts`

**子任务**:
- [ ] 迁移（`migrate_0032`）：建 `tenant` 表 + 主租户 `main` + user/model/vendor/record/recharge_records 加 `tenant_id` 列 + `model` 加 `cross_tenant` 列 + `rule` 加 `tenant_id` / `cross_tenant` 列 + 存量回填（含 `rule`）+ 删除 `model` 全局唯一 `name_index`（`enabled_model_name_index` / `enabled_name` 已在 `migrate_0030` 删除，无需处理）
- [ ] `SgTenant` 模型 + user/model/vendor/record/recharge_records 加 `tenant_id` 字段 + `sgModel` 加 `cross_tenant` 字段
- [ ] 常量 / 配置：`DEFAULT_TENANT_NAME = 'main'`、`ConfigKey.MULTI_TENANT_ENABLED` 功能开关
- [ ] `tenantManager` / `tenantService` / `tenantController`（root 专用 CRUD；`main` 租户不可删；空租户=无 user/model/vendor 才可删，删除时忽略 record / recharge_records）
- [ ] 路由注册 `/tenant/*.json`

**验收标准**:
- 迁移后可正常启动，存量数据全部归入 `main` 租户
- 功能开关关闭时进入逻辑单租户模式：仅暴露 `main`，非 `main` 数据保留且重新开启后恢复

### 任务 2: 租户感知的查询过滤

**描述**: 让 user / model / vendor / vendor_model 的 list / get / create / update / delete，以及 record / recharge_records 的 list / get 按租户过滤。

**依赖**: 任务 1

**核心文件**:
- `src/manager/userManager.ts` / `modelManager.ts` / `vendorManager.ts` / `vendorModelManager.ts` / `recordManager.ts` / `rechargeRecordManager.ts` / `ruleManager.ts`
- `src/service/userService.ts`（充值记录写入落租户）/ `ruleService.ts`（规则校验 / 列表）/ `ruleController.ts`
- 对应 controller
- `src/middleware/authMiddleware.ts`

**子任务**:
- [ ] `tenantScopeMiddleware` 统一解析并注入 `TenantScope`（与「请求的租户区分」一致）：显式指定 `X-Tenant-ID` → 用该租户（root 可指定任意存在的租户、不存在返回 `400`；非 root 必须等于自身 `user.tenant_id`，否则 `403`）；未显式指定 → 用用户所属租户（root 缺省 `main`）；功能开关关闭 → 一律 `main`
- [ ] 租户业务管理端、租户 LLM API、root 全局控制面三类路由分组；全局 config / client-config 仅在 `main` 租户视角可操作，`status.json` / `update.json` 对所有 admin 开放
- [ ] 各 manager 的 list / get / batch / create / update / delete / count / recent 加 `TenantScope` / `tenantId` 参数，在查询层强制收敛而非全局按 ID 查询后再判断
- [ ] 写路径归属校验（防跨租户越权）
- [ ] 充值记录写入落 `recharge_records.tenant_id`（取被充值用户租户）
- [ ] `modelManager.getModel` 加 `tenantId`，按「本租户模型优先、共享模型兜底」稳定排序；`checkDuplicateEnabledModel` 改为启用模型租户内查重（`name + enable=1 + tenant_id`）
- [ ] vendor 名称租户内唯一查重（`name + tenant_id`，创建 / 更新时校验）
- [ ] 模型共享校验：`cross_tenant = 1` 仅限 `main` 租户下的模型
- [ ] 模型 `list` / `get` 特例：非 `main` 租户额外并入 `main` 租户共享模型（`tenant_id = mainId AND cross_tenant = 1`），只读；`count` 与 `list` 一致；写操作（update / delete / 启用）仍按本租户校验，越权返回 `403`；禁用的共享模型在非 `main` 列表仍显示但呈禁用态
- [ ] 规则管理端租户化：`ruleController` / `ruleService` 的 list / get / create / update / delete 加 `TenantScope`；列表 = 本租户规则 ∪ main 共享规则（只读，`cross_tenant = 1` 仅限 main 租户规则）；规则 scope 引用的 vendor 须与规则同租户、模型 / 用户限定「本租户 ∪ main 共享模型」
- [ ] record 的 latest / 详情 / 删除 / 清空 / payload / activity、recharge 的详情 / 列表、stats 原生 SQL 均完成 scope 过滤
- [ ] vendor_model 的间接归属校验，以及模型 routing_config 对 vendor / vendor_model 的同租户校验

**验收标准**:
- admin 只见本租户数据；root 可通过 `X-Tenant-ID` 切换视角、缺失时默认 `main`
- 非 `main` 租户模型置 `cross_tenant = 1` 被拒绝
- 非 `main` 租户模型列表 / 详情可见 `main` 租户共享模型（只读），不可编辑 / 删除

### 任务 3: LLM 调用链路的租户化

**描述**: 让模型解析、`/v1/models` 按调用方租户过滤，并并入共享模型。

**依赖**: 任务 2

**核心文件**:
- `src/service/llmRequestService.ts`
- `src/service/recordService.ts`
- `src/service/ruleService.ts` / `src/manager/ruleManager.ts`（规则求值租户化）
- `src/controller/modelController.ts`（`listLlmModels`）

**子任务**:
- [ ] `resolveContext` 加 `TenantScope` / `tenantId`；root LLM 请求读取 `X-Tenant-ID`，缺失时默认 `main`
- [ ] `listLlmModels` 按租户过滤 + 并入共享模型，并按模型名称以私有模型优先去重
- [ ] 请求记录写入落 `record.tenant_id` = 请求的租户作用域 `TenantScope.tenantId`（root 取 `X-Tenant-ID` / 缺失 `main`，非 root 取 `user.tenant_id`）
- [ ] 规则求值租户化：`ruleManager.listEnabled(tenantId)` 候选 = 本租户规则 ∪ main 共享规则；`ruleService` 缓存按 tenantId 区分；阶段一 / 阶段二规则集按租户解析（root 仍旁路）
- [ ] 共享模型调用 cost 不计入 main 统计（v1 简化），`record.tenant_id` 仍记调用方租户
- [ ] 同名模型跨租户共存的路由验证（租户 A 与 B 同名模型各自解析到各自上游；B 同名私有模型优先于 main 共享模型）

**验收标准**:
- 不同租户的同名模型互不串扰；同名私有模型优先于共享模型
- 调用方可见「本租户模型 + 未被同名私有模型覆盖的共享模型」

### 任务 4: 模型共享语义

**描述**: 实现「租户私有 + 全局共享」的模型引用规则。

**依赖**: 任务 2

**核心文件**:
- `src/manager/modelManager.ts`（`getModel` 解析并入共享模型）
- `src/controller/modelController.ts`（`cross_tenant` 标记管理 API）

**子任务**:
- [ ] 模型解析候选 = 本租户模型 ∪ 共享模型（`tenant_id === callerTenantId OR cross_tenant = 1`），并按本租户模型优先排序
- [ ] 共享模型仅 `main` 租户可增删改；跨租户私有模型引用拒绝
- [ ] `cross_tenant` 标记的管理 API（root / `main` 租户 admin）

**验收标准**:
- 租户可调用共享模型与本租户私有模型，不能调用其它租户私有模型
- 共享模型上游（`main` 租户的 vendor / vendor_model）由网关正确转发

### 任务 5: 前端租户化

**描述**: 管理控制台新增租户管理页、root 视角切换、模型共享开关，列表按租户过滤，功能开关关闭时退回单租户界面。

**依赖**: 任务 1 - 4（后端 API 就绪）

**核心文件**:
- `frontend/src/types/tenant.ts`、`frontend/src/api/tenant.ts`、`frontend/src/stores/tenant.ts`
- `frontend/src/api/gateway.ts`（playground 追加 `X-Tenant-ID`）
- `frontend/src/views/Tenant/`（Index / List / DialogCreate / DialogEdit）
- `frontend/src/views/Rule/`（规则列表 / 表单加共享开关）
- `frontend/src/router/index.ts`、`frontend/src/components/layout/AppHeader.vue`（或 `AppSidebar.vue`）
- `frontend/src/types/model.ts`、`frontend/src/views/Model/DialogForm.vue`
- `frontend/src/views/AdvancedSettings.vue`

**子任务**:
- [ ] 新增租户管理页（root 专用），`main` 租户不可删
- [ ] root 视角切换器 + 统一 HTTP 请求拦截器：为所有请求追加当前视角的 `X-Tenant-ID`
- [ ] 模型表单加「跨租户共享」开关，仅 `main` 租户模型可勾选
- [ ] 规则管理页租户化：列表并入 main 共享规则（只读、标注「共享」）；表单加「全局共享」开关（仅 main 视角可勾选）
- [ ] `gateway.ts` 原生 fetch / fetchEventSource 追加当前视角 `X-Tenant-ID`（playground 租户化，与 `utils/request` 拦截器同一数据源）
- [ ] `ConfigKey.MULTI_TENANT_ENABLED` 配置项；功能开关关闭时隐藏租户相关 UI
- [ ] 侧边栏 config 与 client-config 入口仅在 `main` 租户视角下显示（非 `main` 视角隐藏）
- [ ] 前端构建通过

**验收标准**:
- root 可管理租户、切换视角；admin 无视角切换、只见本租户数据
- 仅 `main` 租户模型可勾选「跨租户共享」
- 功能开关关闭时退回单租户界面

### 任务 6: 测试与回归

**描述**: 补租户隔离的单元 / 集成测试，全量回归。

**依赖**: 任务 1 - 5

**核心文件**:
- `tests/unit/`、`tests/api/`、`tests/integration/` 对应新增

**子任务**:
- [ ] tenant CRUD 测试
- [ ] 租户过滤 / 越权拦截测试
- [ ] 模型共享路由测试
- [ ] 规则租户化测试（共享规则全租户生效 / 私有规则仅本租户 / 非 `main` 不可改共享规则 / 共享限流全局计数）
- [ ] 模型 / 供应商名租户内唯一查重（应用层校验）测试
- [ ] 存量迁移测试（`main` 租户回填）
- [ ] 功能开关关闭测试（逻辑单租户：仅 main 可访问、非 main 数据保留、重新开启后恢复）
- [ ] root LLM 的 `X-Tenant-ID` 指定与缺失默认 main 测试
- [ ] root 指定不存在租户返回 `400`、普通用户显式指定非自身租户返回 `403` 测试
- [ ] 请求记录 `record.tenant_id` 归属测试（非 root 归自身租户、root 归视角租户）
- [ ] config / client-config 仅 `main` 视角可访问、`status.json` / `update.json` 对所有 admin 开放测试
- [ ] 所有按 ID / batch / 删除 / 清空 / payload / activity / stats 接口的跨租户越权测试
- [ ] 同名私有模型覆盖共享模型，以及 `/llm/v1/models` 去重测试
- [ ] 非 `main` 租户模型列表 / 详情可见 `main` 租户共享模型（只读）、不可编辑 / 删除测试
- [ ] 共享模型禁用态在非 `main` 列表呈禁用、共享规则只读测试
- [ ] node 模式全量测试 + TypeScript 类型检查 + 前端构建

**验收标准**:
- 全量 node 测试通过、类型检查通过、前端构建通过

---

## 总体验收

- [ ] 迁移后可正常启动，存量数据全部归入 `main` 租户；功能开关关闭时退回单租户行为（任务 1）
- [ ] admin 只见本租户数据；root 通过 `X-Tenant-ID` 切换视角、缺失时默认 `main`（任务 2）
- [ ] 不同租户的同名模型互不串扰，各自解析到各自上游（任务 3）
- [ ] 租户可调用共享模型与本租户私有模型，不能调用其它租户私有模型；仅 `main` 租户模型可标记共享（任务 4）
- [ ] 非 `main` 租户模型列表可见 `main` 租户共享模型（只读）、不可编辑 / 删除（任务 2）
- [ ] 前端租户管理页 / 视角切换 / 模型共享开关 / 开关关闭退回单租户界面（任务 5）
- [ ] tenant CRUD / 过滤 / 越权拦截 / 模型共享 / 存量迁移 / 功能开关测试齐全（任务 6）
- [ ] 全量 node 测试通过、TypeScript 类型检查通过、前端构建通过
