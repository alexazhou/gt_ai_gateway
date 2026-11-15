# main 租户 admin 与 root 管理权限对齐 — 技术文档

## 设计要点

把「是否 root」这一散落各处的判断，统一替换为**单一来源**的 `TenantScope.isSystemAdmin`：

```
isSystemAdmin = user.type === ROOT
             || (user.type === ADMIN && user.tenant_id === main 租户 id)
```

只覆盖**管理权限**（租户管理 / 跨租户视角 / 多租户开关）。LLM 调用权限不由作用域承载：规则层对所有用户一视同仁，`ruleService` 不再按身份旁路（本次一并移除了原有的 root 旁路）。root 的身份性差异（`ROOT_USER_ID` / 无限余额 / 不计费）仍由 `user.type` 分支承担，与作用域无关。

判定在**作用域解析时一次算出**并随 `TenantScope` 传递，下游（controller / ruleService）只读该字段，不再各自判断 `user.type`。这样：

- 消除 `user.type === ROOT` 与「main 租户 admin」两套判断的口径分叉；
- 需要 `main 租户 id` 的地方统一由 `resolveScopeForUser` 解析（`tenantService.getMainTenantId()` 已带内存缓存）；
- LLM 热路径无需额外查库 —— `ruleService` 直接读入参 scope 上的布尔值。

## 改动清单

### 1. `src/middleware/tenantScopeMiddleware.ts`

- **`TenantScope` 增加 `isSystemAdmin: boolean`**（原 `isRoot` 字段只服务于已移除的规则旁路，直接替换）。
- **`resolveScopeForUser`**：算出 `isSystemAdmin`；跨租户指定 `X-Tenant-ID` 的放宽条件用它。
- **`resolveScopeForUser`**：新增私有判定 `computeIsSystemAdmin(user, mainTenantId)`（`ROOT` 恒真；`ADMIN` 须 `tenant_id === mainTenantId`；其余为假）。作用域解析由「root 可任意指定租户」放宽为「系统管理员可任意指定」（不存在的租户仍 `400`）。
- **新增 `requireMainView` 中间件**：解析作用域并要求 `scope.tenantId === scope.mainTenantId`，否则 `403`；同时注入 `tenantScope`。用于全局控制面。
- **新增 `tenantScope` 中间件的用途说明**：仅注入作用域、不做校验（`/tenant/*`、`/status.json` 用）。

### 2. `src/routes.ts`

| 路由 | 中间件 |
|------|--------|
| `/status.json` | `requireAdmin` + `tenantScope`（下发 `is_system_admin`） |
| `/config.json` PUT、`/client-config/*` | `requireAdmin` + `requireMainView` |
| `/config.json` GET | 维持 `requireAdmin`（不限制视角） |
| `/tenant.json`、`/tenant/:id` | `requireAdmin` + `tenantScope`（系统管理员校验在 controller 内） |

> **`/config.json` 只限制写、不限制读**：侧边栏的遥测 / 更新检查与模型表单的计费开关会**无条件**调用 `getConfig()`，与当前视角无关；限制读会让非 main 视角的 admin 丢失这些全局能力（auto-update 提示、计费价格字段）。写入（改全局配置）才是「设置」页的能力，故只在 PUT 上要求 main 视角。
> 前端同步给 `/client-manager`、`/advanced-settings`、`/developer` 三个路由补上 `requiresMainView` 元信息，与侧边栏入口的显示条件一致。

> 租户业务前缀（`/user/*`、`/model/*` 等）仍走既有的 `tenantScopeMiddleware.requireTenantAdmin`，其内部已解析作用域，`isSystemAdmin` 随之可用。

### 3. Controller

- **`tenantController`**：`assertRoot`（读 `c.get("user_type")`）→ `assertSystemAdmin`（读 `c.get("tenantScope")?.isSystemAdmin`），5 个接口统一；错误信息 `System administrator access required`。
- **`configController.updateConfig`**：仅当**确实要改值**（`String(body[key]) !== 当前值`）且调用方非系统管理员时 `403`。按「是否携带该字段」判断会把「顺带提交整份配置（如只改 `host_key`）」也一并拒绝，故用值比较。
- **`systemController.status`**：响应新增 `is_system_admin`。

### 4. `src/service/ruleService.ts`

`matchAndCheck` / `matchAndCheckVendor` 的入参由 `(..., tenantId, mainTenantId)` 改为 `(..., scope: TenantScope)`，同时**移除 root 旁路**：不再有 `user.type === ROOT` 的提前返回，所有用户走同一条匹配与计数路径。调用方同步：

- `llmApiMiddleware`：`matchAndCheck(user, modelConfig, scope)`
- `senderService`：`matchAndCheckVendor(user, modelConfig, vendor, scope)`

**作用域必然存在**：进入 `senderService.sendRequest` 的两条路径都已注入 `tenantScope`（LLM 端点由 `llmApiMiddleware` 注入，`/model/route-test.json` 由 `requireTenantAdmin` 注入），因此 `TenantScope.tenantId` 恒为真实租户 id，不需要 `-1` / `null` 之类的哨兵值。`senderService` 与各 controller 一致用 `c.get("tenantScope")!` 取用。

### 5. 前端

- `types/system.ts`：`StatusResponse` 增加 `is_system_admin`。
- `stores/auth.ts`：新增 `isSystemAdmin`（来自 `/status.json`；旧后端不下发该字段时回退 `user_type === 'root'`，保持改造前行为），`clearToken` 时重置；`isRoot` 保留（前端仅用于展示 / 语义区分，不再用于入口判定）。
- 入口判定统一改用 `authStore.isSystemAdmin`：
  - `AppSidebar.vue` 租户管理菜单
  - `AppHeader.vue` 顶栏视角切换 + `loadTenants()` 触发条件
  - `router/index.ts` meta `requiresRoot` → `requiresSystemAdmin`
  - `Developer.vue` 多租户开关 `:disabled`，且保存时非系统管理员**不提交** `multi_tenant_enabled` 字段

> 前端不自行拼装判定条件：`/status.json` 的 `tenant.main_id` 在隔离开关关闭时为 `null`，前端拿不到 main 租户 id，判定必须由后端下发。

## 技术要点

- **为什么判定在 scope 解析时做**：`main 租户 id` 只在 `tenantService` 一处可解析；把它下沉到各 controller / service 会导致同一规则多处重复实现（`record` / `model` / `rule` 三条链路都涉及）。
- **为什么规则旁路被移除**：原设计让 root 全程旁路，理由之一是 Tauri 桌面用 root token、不能被拦截。但规则只作用于 `/llm/v1/*` 的调用入口，自动登录与全部管理端 API 都不经过 ruleService，本就与规则无关；而旁路会让「全局兜底拒绝」这类规则管不住 root 的 LLM 调用。本次统一为「规则层无身份豁免」，需要放行 root 的 LLM 调用时改用规则条件显式排除（如 `user_id not in [-1]`）。
- **为什么 `isSystemAdmin` 不随隔离开关变化**：把「隔离关闭 ⇒ 所有 admin 都是系统管理员」留给产品决策（见 step1「已知影响」），实现层只提供一致、可预测的判定。隔离关闭时作用域恒为 main，故 `requireMainView` 与依赖 `scope.tenantId` 的逻辑自然放行。
- **`status.json` 在隔离关闭时也返回 `is_system_admin`**：该字段不依赖 `main_id`，恒可计算。

## 测试要点

- `tests/api/permission/systemAdmin.test.ts`（新增）：`/status.json` 标志位、租户 CRUD、跨租户视角、多租户开关（改值 403 / 携带原值 200）、全局控制面 main 视角限制、隔离关闭时非 main admin 仍非系统管理员。
- `tests/api/tenant/tenant.test.ts`：原「admin 访问租户管理 → 403」等用例按角色拆分 —— main admin 放行、tenant-b admin 仍 `403`。
- `tests/integration/ruleService.node.test.ts`：新增「规则对所有用户（含 root）一律生效」的用例，替换原 root 旁路用例。
- `tests/api/rule/rule.test.ts`：原「root bypasses all rules」端到端用例改为「root 同样被 403 拦截」，并断言删掉规则后恢复 200。
