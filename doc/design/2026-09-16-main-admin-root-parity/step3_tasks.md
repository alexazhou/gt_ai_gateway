# main 租户 admin 与 root 管理权限对齐 — 开发任务

## 后端

- [x] `tenantScopeMiddleware`：`TenantScope.isRoot` → `isSystemAdmin`（root 或 main 租户 admin）；`resolveScopeForUser` 内新增 `computeIsSystemAdmin`；跨租户放宽条件用它
- [x] `tenantScopeMiddleware`：新增 `requireMainView` 中间件（全局控制面写侧仅 main 视角）；不引入哨兵作用域 —— 作用域在 LLM / 模型测试两条路径上必存在
- [x] `routes.ts`：`/status.json` 注入 `tenantScope`；`/config.json` PUT 与 `/client-config/*` 增加 `requireMainView`（GET 保持所有 admin 可读）；`/tenant/*` 注入 `tenantScope`
- [x] `tenantController`：`assertRoot` → `assertSystemAdmin`（读 `tenantScope.isSystemAdmin`），5 个接口统一
- [x] `configController.updateConfig`：`multi_tenant_enabled` 改值需系统管理员，按值比较避免连带拒绝
- [x] `systemController.status`：响应新增 `is_system_admin`
- [x] `ruleService`：`matchAndCheck` / `matchAndCheckVendor` 入参改为 `TenantScope`，并**移除 root 旁路**（规则对所有用户一视同仁）；`llmApiMiddleware` / `senderService` 调用点同步

## 前端

- [x] `types/system.ts`：`StatusResponse.is_system_admin`
- [x] `stores/auth.ts`：`isSystemAdmin`（含旧后端回退），`clearToken` 重置
- [x] `AppSidebar.vue` 租户管理菜单、`AppHeader.vue` 视角切换与 `loadTenants()`、`router/index.ts` meta `requiresSystemAdmin`、`Developer.vue` 开关禁用与提交字段
- [x] `router/index.ts`：`/client-manager`、`/advanced-settings`、`/developer` 补 `requiresMainView`，与后端写侧校验一致

## 测试

- [x] 新增 `tests/api/permission/systemAdmin.test.ts`：角色矩阵（root / main admin / tenant-b admin）
- [x] `tests/api/tenant/tenant.test.ts`：按角色拆分原「admin → 403」用例（main admin 放行、tenant-b admin 403）
- [x] `tests/integration/ruleService.node.test.ts`：`tenantScope()` 辅助函数替换原 `tenantId, mainTenantId` 入参；原 root 旁路用例改为「规则对所有用户（含 root）一律生效」
- [x] `tests/api/rule/rule.test.ts`：原「root bypasses all rules」e2e 改为「root 同样被 403 拦截」，并断言删规则后恢复 200
- [x] `tests/integration/ruleManager.node.test.ts`：scope fixture 字段更名
- [x] 全量 node 模式测试、`backend:test:type`、前端构建通过

## 文档

- [x] 新增本专项 step1 / step2 / step3
- [x] 在 step1 补「与既有设计文档的关系（取代说明）」：历史文档不回改，列明被取代的条目（租户管理 / 视角切换 / 多租户开关的 root 专用、root 规则旁路）及现口径
- [x] `ROADMAP.md`：补充条目与索引

## 遗留 / 后续

- 单租户部署下 admin ≡ root 的语义需在产品侧知悉（见 step1「已知影响」）。
- 若后续放开用户跨租户迁移，`isSystemAdmin` 的判定基准（`user.tenant_id`）需随之重新评估。
- 移除 root 旁路后，**用 root token 发起的 LLM 调用**（桌面端 API 体验页、以 root token 配置的外部客户端）会被全局拒绝规则拦截；自动登录与管理端操作不受影响。如需放行须在规则条件里显式排除（`user_id not in [-1]`）。
