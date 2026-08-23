# 多租户隔离（Tenant）- 技术文档

> 状态：规划中（尚未实施）

## 架构概览

「软隔离 / 归属标签」语义：`tenant_id` 是归属标签 + 默认过滤维度，不是硬性行级安全策略。

- 多租户隔离是数据库配置项（`ConfigKey.MULTI_TENANT_ENABLED`）：关闭时进入逻辑单租户模式，所有租户业务请求固定填充 `main`；非 `main` 数据保留但不可访问。开启时所有请求**必须**按租户过滤，接口不支持跨租户取全量数据。
- 普通 admin / normal 的读写固定按本租户过滤（防越权）。
- 每个请求解析到单一租户：显式指定 `X-Tenant-ID` 时用它（root 可指定任意存在的租户；非 root 必须等于自身 `user.tenant_id`，否则 `403`）；未指定时用用户所属租户（root 缺省 `main`）。关闭时所有请求一律落入 `main`，显式指定非 `main` 租户时报错。

隔离维度落在 `user` / `model` / `vendor` 三类实体上（归属），请求规则 `rule` 同样按租户归属；`vendor_model` 通过 `vendor` 间接归属；`record` / `recharge_records` 冗余 `tenant_id`（请求记录取请求的租户作用域，充值记录取被充值用户租户）便于按租户过滤与统计；`rule` 归属租户并支持 `cross_tenant` 全局共享。

跨租户共享**仅作用于模型**：只有 `main` 租户下的模型可标记为全局共享，供应商不支持共享。

## 命名落地

| 概念 | 命名 |
|------|------|
| 数据表 | `tenant` |
| 模型 | `SgTenant` |
| 外键列 | `tenant_id` |
| 共享标记列 | `model.cross_tenant` |
| Manager / Service / Controller | `tenantManager` / `tenantService` / `tenantController` |
| API 路径 | `/tenant/*.json`（REST，符合 `.json` 约定） |
| 租户视角 header | `X-Tenant-ID` |
| 常量 / 配置 | `DEFAULT_TENANT_NAME = 'main'`、`ConfigKey.MULTI_TENANT_ENABLED` |

## 决策记录

| 决策点 | 结论 | 说明 |
|--------|------|------|
| 命名 | **租户 tenant** | 备选：命名空间 namespace / 工作区 workspace / 空间 space |
| 主租户名 | **main** | 默认租户名，迁移生成，不可删除 |
| 跨租户共享 | **仅模型支持** | 模型可全局共享，供应商不支持共享 |
| 名称唯一性 | **应用层校验** | 模型（仅启用）/ 供应商名的租户内唯一由代码查重，不在 DB 建生成列 / 唯一索引；仅 `tenant.name` / `user.token` 保留 DB 全局唯一 |
| 隔离强度 | **软隔离 / 归属标签** | `tenant_id` 是归属标签 + 默认过滤维度，root 须显式指定租户 |
| 功能开关 | **可关闭** | 关闭后逻辑上仅暴露 `main`；非 `main` 数据保留，重新开启后恢复 |
| 请求规则 | **租户归属 + 全局共享** | 私有规则仅本租户；`cross_tenant = 1` 共享规则仅 `main` 租户可配置、对所有租户生效；共享限流按 `rule.id` 全局计数 |

**模型共享的建模方式**：采用 `model.cross_tenant` 布尔标记，而非 `tenant_id` 可空。模型始终归属某租户（`tenant_id` 非空），`cross_tenant = 1` 表示该模型对所有租户可见；且仅当 `tenant_id` 为 `main` 租户时允许置 `cross_tenant = 1`（写路径校验）。这样「归属 `main` 租户 + 共享」两个信息并存，与产品语义一致。

## 数据模型

### 新增 `tenant` 表

表结构要点：`id` 自增主键、`name`（**全局唯一**，租户标识）、`description`、`created_at` / `updated_at`。迁移为双方言（`mysql.sql` + `sqlite.sql`，dbMigrationService 按方言选择），`tenant.name` 唯一索引随表创建。

### 存量表加列

以下表各加一列 `tenant_id`（归属租户）：`user` / `model` / `vendor` / `record` / `recharge_records`；`model` 额外加 `cross_tenant`（模型全局共享标记）；`rule` 额外加 `tenant_id` + `cross_tenant`（规则全局共享标记）。

- 各 `tenant_id` 列：回填后**应用层强制非空**（DB 层沿用项目惯例——列可空，实际值由应用代码写入，参见 `migrate_0026` 的处理方式）。
- `model.cross_tenant`：`1` = 全局共享（对所有租户可见）；`0` = 租户私有。仅 `main` 租户下的模型可置为 `1`。
- `rule.cross_tenant`：`1` = 全局共享规则（对所有租户生效）；`0` = 租户私有。仅 `main` 租户规则可置为 `1`。
- `vendor_model` **不加** `tenant_id`，通过 `vendor` 间接归属，避免冗余不一致。
- `record.tenant_id` / `recharge_records.tenant_id`：请求 / 充值记录**冗余租户**，便于按租户过滤与统计。请求记录取请求的租户作用域 `TenantScope.tenantId`（root 取 `X-Tenant-ID` 视角、缺失 `main`；非 root 取自身 `user.tenant_id`）；充值记录取被充值用户的 `tenant_id`。该冗余的一致性依赖「用户不可跨租户迁移」这一 v1 约束，后续放开用户迁移时需同步回写历史记录。

### 唯一约束调整（隔离的核心）

模型 / 供应商名的「租户内唯一」**不在数据库层建约束**，改由应用层在写路径查重（简化 DB 设计，避免生成列等复杂机制）：

- **模型名（仅启用时）租户内唯一**：`checkDuplicateEnabledModel` 增加 `tenantId` 参数，创建 / 更新 / 启用模型时按 `name + enable=1 + tenant_id` 查重。
- **供应商名租户内唯一**：vendor 创建 / 更新时按 `name + tenant_id` 查重。
- 代价：失去 DB 层兜底，极端并发（两个请求同时创建同名资源）存在竞态窗口。模型 / 供应商为低频管理操作，可接受。

DB 层仅保留两个**全局唯一**约束（简单、无条件）：`user.token`（登录凭证，跨租户不能重复）、`tenant.name`（租户标识）。

同时删除 `model` 的**全局唯一 `name` 索引**（`migrate_0030` 引入），否则跨租户同名模型会被它拦截（`enabled_model_name_index` 生成列索引已在 `migrate_0030` 删除，无需再处理）。删索引后模型名唯一性完全依赖应用层按租户查重。

共享模型不占用其它租户的同名私有模型（模型解析按「本租户优先」去重）。

## 模型共享语义

- `model.cross_tenant = 1` → 全局共享，**任何租户均可按名称调用**，仅 root（处于 `main` 视角）或 `main` 租户 admin 可增删改。
- `model.cross_tenant = 0` → 租户私有，**仅本租户可见**。

**模型解析**（`modelManager.getModel`）：按名称解析时，候选 = 「本租户模型 ∪ 共享模型」（即 `tenant_id` 等于调用方租户，或 `cross_tenant = 1`），同名时**本租户模型优先**。`main` 租户内的启用模型名称已由应用层查重保证无歧义。查询必须**显式排序**而不得依赖 DB 默认顺序（本租户排在共享模型之前）；`/llm/v1/models` 按同一优先级按名称去重，仅返回调用方最终可解析到的模型。

共享模型的 `vendor` / `vendor_model` 上游属于 `main` 租户，由网关代为转发；调用方租户无需直接引用供应商，故**供应商无需跨租户可访问性校验**（共享在模型层闭环）。

**管理端模型列表**（`modelManager.list` / `modelController.list`）：非 `main` 租户（admin 或 root 处于非 `main` 视角）的模型列表 = 本租户模型 ∪ `main` 租户的共享模型（`tenant_id = mainId AND cross_tenant = 1`），共享模型**只读**。该列表**不按名称去重**（与 `/llm/v1/models` 不同）——`main` 租户共享模型与本租户同名私有模型是两个独立资源，各自成行；共享模型通过「`tenant_id` ≠ 本租户 且 `cross_tenant = 1`」识别，前端据此置为只读。详情 `get` 同理允许读取共享模型；编辑 / 删除 / 启用等写操作仍受归属校验拦截（`403`）。`count` 与 `list` 语义一致（含共享模型），保证分页正确。共享模型若 `enable = 0`，在非 `main` 租户列表**仍显示但呈禁用状态**（管理列表不过滤启用状态，LLM 调用端按 `enable` 过滤）。

## 请求规则租户化

- `rule` 归属租户：`tenant_id`（存量回填 `main`）+ `cross_tenant`（1 = 全局共享）。仅 `main` 租户规则可置 `cross_tenant = 1`（写路径校验）。
- **规则解析**（`ruleManager.listEnabled(tenantId)`）：候选 = 本租户规则 ∪ `main` 租户共享规则（`tenant_id = tenantId OR (tenant_id = mainId AND cross_tenant = 1)`）。`ruleService.getEnabledRules` 缓存按 `tenantId` 区分，避免跨租户串计数。
- **求值**：阶段一 / 阶段二（`ruleService.matchAndCheck` / `matchAndCheckVendor`）接收 `TenantScope`，规则集按租户解析；root 仍旁路。
- **限流计数**：共享规则按 `rule.id` 全局统计（全网关一个预算，语义即全网关级策略）；租户私有规则仅被本租户请求命中，天然按租户隔离。
- **规则 scope 引用约束**：私有规则引用的 `vendor_id` 必须属本租户；共享（`main`）规则引用 `main` 的 vendor。`model_id` / `user_id` 允许引用「本租户资源 ∪ main 共享模型」。
- **管理端**（`ruleController` / `ruleService`）：列表 = 本租户规则 ∪ main 共享规则（只读）；共享规则 update / delete / 启用被归属校验拦截（`403`）。`cross_tenant` 字段仅 `main` 租户视角可置 `1`。

## 软隔离与权限层级

| 角色 | 行为 |
|------|------|
| `ROOT`（虚拟 `ROOT_TOKEN`） | 全局：管理 tenant 本身（增删改）；租户业务请求从 `X-Tenant-ID` 取视角，缺失时默认 `main` |
| `ADMIN` | 归属某租户，默认只看本租户数据；**不能**切换到其他租户 |
| `NORMAL` | 归属某租户，仅调用 LLM API |

「软隔离」的落地：`tenant_id` 是**归属标签 + 默认过滤维度**，不是硬性行级安全策略。普通 admin 的读写仍按本租户过滤（防越权）；root 通过 `X-Tenant-ID` 选择租户视角，也不绕过过滤。

**功能开关关闭时**：`ConfigKey.MULTI_TENANT_ENABLED = false` 时，所有租户业务请求固定填充 `main`，退回逻辑单租户行为；非 `main` 数据保留但不暴露，租户管理 API 禁用。请求通过 `X-Tenant-ID` 显式指定非 `main` 租户时返回错误，不静默回退为 `main`。

## 请求链路改动

### 统一租户上下文（middleware / controller / manager）

所有租户业务接口统一经过 `tenantScopeMiddleware`，解析并注入不可由请求 body 覆盖的 `TenantScope`（至少包含 `tenantId`、来源和功能开关状态）。路由分为三类：

- **租户业务管理端**：user / vendor / model / vendor_model / record / recharge / stats；统一使用 `TenantScope`。
- **租户 LLM API**：模型列表与 LLM 调用；统一使用 `TenantScope`。
- **root 全局控制面**：tenant CRUD（root 专用）；全局 config 与 client-config 仅在 `main` 租户视角下暴露（root 视角为 `main`、或 admin 自身租户为 `main`），非 `main` 视角隐藏 / 拒绝；`status.json` / `update.json`（状态、更新检查）等只读接口对所有租户的 admin 开放，保持 `requireAdmin` 不变（不按租户隔离）。client-config 中的 `model` 字段按 `main` 租户模型解析（v1 简化处理，暂不支持按调用方租户解析）；client-config 仅 `main` 租户视角可用，`client_config` 的 `(client, name)` 全局唯一索引在 v1 无冲突（若后续放开非 `main` 租户 client-config 需重审 `client_config_client_name_unique`）。

middleware 只负责解析 scope；数据隔离由 manager 强制执行。所有 tenant-owned 资源的 `list / get / batch / create / update / delete / count / recent` 均接收 `TenantScope` 或 `tenantId`，在查询条件中收敛。不得先全局按 ID 查询、再由 controller 判断归属。

### 管理端（controller / manager）

- `authMiddleware.requireAdmin`：鉴权后注入完整 `user` 对象（`c.set("user", user)`，含 `id` / `type` / `tenant_id`；root 的 `tenant_id` 为 `null`，当前代码只 `c.set("user_type", ...)` 需一并补上 `user`）。租户由 `tenantScopeMiddleware` 从上下文派生。
- 租户解析（controller 统一，与产品文档「请求的租户区分」一致）：
    - 功能开关关闭：`tenantId = main`（显式指定非 `main` 时返回错误）。
    - 功能开关开启：
        - 显式指定 `X-Tenant-ID` → 使用该租户（root 可指定任意存在的租户，不存在返回 `400`；非 root 必须等于自身 `user.tenant_id`，否则 `403`）。
        - 未显式指定 → 使用用户所属租户（非 root 取 `user.tenant_id`；root 无归属，缺省 `main`）。
- 各 manager 的 `list / get / create / update / delete` 增加 `tenantId` 参数，controller 传入解析后的 `tenantId`（开启时必填）。
- 归属校验：写操作（创建 / 更新 / 删除）需校验目标资源属于当前解析出的租户（root 也受此约束，仅能操作其指定视角租户内的资源），防止跨租户越权读写。
- 模型列表 / 详情特例：非 `main` 租户的模型 `list` / `get` 额外并入 `main` 租户的共享模型（`cross_tenant = 1`）并置只读；其余管理操作（update / delete / 启用等）仍严格按本租户过滤，越权返回 `403`。
- 模型共享校验：置 `cross_tenant = 1` 时，校验模型归属 `main` 租户，否则拒绝。
- 充值记录写入时落 `recharge_records.tenant_id`（取被充值用户的 `tenant_id`）。
- 创建资源时的 `tenant_id` 由 `TenantScope` 服务端写入；客户端 body 中的 `tenant_id` 必须拒绝或忽略。已有用户、模型和供应商本版本不支持跨租户迁移。
- `vendor_model` 通过 vendor 间接隔离；模型路由配置中的 vendor / vendor_model 必须属于模型归属租户。共享模型的上游则必须属于 `main`。
- record 的详情、latest、删除、清空、payload、activity 以及 recharge 的详情和列表均须使用 scope。`clear-all` / `clear-payload` 按当前租户清空（不再全局清空，接口名保留）。统计原生 SQL 必须显式追加 `tenant_id` 条件。
- `request_activity` / `storage_record` **不冗余 `tenant_id`**，经 `record_id` 间接隔离（record 访问已按租户收敛，无泄露）。
- `clear-payload` 落地：payload 存于对象存储 `record/{recordId}`（`recordId` 全局唯一），现有 `clearPayloads()` 是 `deleteByPrefix("record/")` 全量删，需改为按租户 = 先查该租户 record id 列表再逐个删 key；`clear-all` 按租户删 record 行。

### LLM 调用端（middleware / service）

- `llmRequestService.resolveContext` 增加 `TenantScope` / `tenantId` 入参，内部 `modelManager.getModel(modelName, enable, tenantId)`（按本租户优先、共享兜底解析）。
- `modelController.listLlmModels`（`/llm/v1/models`）改为按调用方租户过滤 + 并入共享模型，并按名称去重。
- 请求记录写入时落 `record.tenant_id` = 请求解析出的租户作用域 `TenantScope.tenantId`（root 取 `X-Tenant-ID`、缺失 `main`；非 root 取自身 `user.tenant_id`），不再区分模型归属或失败回退。
- 规则准入（`ruleService.matchAndCheck` / `matchAndCheckVendor`）接收 `TenantScope`，规则集按租户解析（见「请求规则租户化」）。
- 共享模型调用：`record.tenant_id` 记调用方租户，`main` 侧成本统计不计入（v1 简化——`main` 承担上游账单，但统计口径不含共享模型的跨租户调用）。

## API 设计

### 租户管理（root 专用）

```
GET    /tenant.json               # 租户列表
GET    /tenant/:id                # 租户详情
POST   /tenant.json               # 创建租户（功能开关开启时才允许）
PUT    /tenant/:id                # 更新租户
DELETE /tenant/:id                # 删除租户（空租户=无 user/model/vendor 才可删；main 租户不可删；删除时忽略 record / recharge_records）
```

> 注：租户 detail 路由用裸 `/tenant/:id`（与 `/vendor/:id`、`/model/:id` 一致）。Hono 对 `:id.json` 的「参数 + .json 后缀」解析有缺陷（`c.req.param("id")` 取不到值），故不加 `.json` 后缀。

### 模型共享标记（main 租户模型专用）

`/model` 的创建 / 更新增加 `cross_tenant` 字段：仅 `main` 租户下的模型可置 `cross_tenant = 1`，其它租户请求置 `1` 时拒绝。

### 既有资源接口租户化

`/user`、`/vendor`、`/model`、`/vendor_model`、`/record` 现有端点保持 URL 不变，仅增加租户过滤行为：

- 开启隔离时，所有租户业务请求按 `TenantScope` 过滤：root 从 `X-Tenant-ID` 选择视角，缺失时为 `main`；非 root 固定取 `user.tenant_id`，但传入不一致的 header 返回 `403`。
- 关闭隔离时，所有请求默认填充 `main` 租户；`X-Tenant-ID` 指定非 `main` 时返回错误。

## 迁移（仓库基线为 `migrate_0031`，新迁移为 `migrate_0032`，目录内含 `mysql.sql` + `sqlite.sql`）

迁移分四步：

1. **建 `tenant` 表 + 主租户**：表结构见「数据模型」，随后写入一条 `name = 'main'`（主租户，迁移生成，不可删除）。
2. **加列**：`user` / `model` / `vendor` / `record` / `recharge_records` 加 `tenant_id`；`model` 加 `cross_tenant`；`rule` 加 `tenant_id` + `cross_tenant`。
3. **存量回填 `main`**：上述各表的 `tenant_id` 统一回填为 `main` 租户 id，`cross_tenant` 保持 0 —— `main` 租户 == 迁移前的全局状态，行为不变；之后由 root 决定把哪些 `main` 租户模型 / 规则标记为共享（`cross_tenant = 1`）。
4. **删 `model` 全局唯一 `name` 索引**（`migrate_0030` 引入）：跨租户同名模型要求它不存在，名称唯一性改由应用层按租户查重。

> **功能开关默认值**：存量单租户部署迁移后 `ConfigKey.MULTI_TENANT_ENABLED` 默认关闭，行为与迁移前一致；需要多租户时由 root 显式开启。

## 前端改动

前端为 Vue 3 + Pinia + Vue Router（hash）管理控制台，按「root 视角切换 + 租户管理 + 模型 / 规则共享开关 + 功能开关 + 全局配置入口 + playground 租户化」落地：

- **租户管理页**（root 专用）：租户 CRUD 界面，`main` 租户不可删；入口（菜单 + 路由）仅在 root 登录且功能开关开启时可见。
- **视角切换**：root 登录后可切换视角租户（默认 `main`）；前端用全局 store 保存当前租户，并在统一 HTTP 请求拦截器中为所有请求追加 `X-Tenant-ID`。admin 无视角切换入口；其 header 必须与登录用户租户一致，否则后端返回 `403`。
- **模型共享开关**：模型表单新增「跨租户共享」开关，读写 `model.cross_tenant`；仅 `main` 租户下的模型可勾选（以后端校验为准，前端按模型归属禁用勾选）。
- **模型列表只读共享模型**：非 `main` 租户视角下，模型列表额外渲染 `main` 租户的共享模型，标注「共享」并禁用编辑 / 删除 / 启用等操作（按「`tenant_id` ≠ 本租户 且 `cross_tenant = 1`」识别）。
- **功能开关**：`ConfigKey.MULTI_TENANT_ENABLED` 仅 root 可在设置页修改；关闭时清除非 `main` 视角、隐藏租户管理与视角切换入口，退回逻辑单租户界面。
- **全局配置入口**：侧边栏 config（设置）与 client-config（客户端配置）入口仅在 `main` 租户视角下显示；非 `main` 视角（root 切换到其它租户、或 admin 归属非 `main`）隐藏该入口，后端 `config.json` 同步校验仅 `main` 视角可访问。
- **规则页租户化**：规则列表并入 `main` 租户共享规则（标注「共享」、只读）；规则表单新增「全局共享」开关，仅 `main` 租户视角可勾选。
- **LLM 调用（前端 playground）**：`frontend/src/api/gateway.ts` 的原生 `fetch` / `fetchEventSource` 不走 `utils/request` 拦截器，需单独从 tenant store 读取当前视角并追加 `X-Tenant-ID`，保证 root 在非 `main` 视角下 playground 测试打到正确租户。

前后端协作约定：前端统一通过 `X-Tenant-ID` 传递当前视角；后端在租户业务请求中对 root 采纳该 header，对非 root 校验其必须等于自身租户。模型共享通过 `cross_tenant` 字段读写；租户 CRUD 走 `/tenant/*.json` 且忽略该 header。

## 相关文档

- [产品文档](./step1_product.md)
- [开发任务表](./step3_tasks.md)
