# 网关认证与权限架构说明

## 1. 概述

网关将所有受保护的请求拆解为三个正交阶段，在进入 Controller 之前由中间件按 **Fail-Fast（遇错即抛）** 原则依次完成：

```text
请求进入
  │
  ├─ Step 1: 身份认证 (Authentication — Who are you?)
  │    提取凭证 (Bearer / x-api-key) → userService.authenticateByToken → 注入 c.set("user", user)
  │
  ├─ Step 2: 租户作用域 (Scope Resolution — Where are you operating?)
  │    结合 user + X-Tenant-ID + 多租户开关 → tenantService.resolveScopeForUser → 注入 c.set("tenantScope", scope)
  │
  └─ Step 3: 准入守卫 (Authorization / Guard — Are you allowed?)
       ├─ 管理端 (authMiddleware)：校验管理员角色、main 视角、系统管理员或 Root 身份
       └─ LLM 端 (llmApiMiddleware)：校验请求体上限、解析目标模型、执行路由前规则准入与限流
```

所有中间件与领域服务在校验失败时统一抛出 `customError.AppError(message, statusCode, code)`，由 `src/routes.ts` 的全局 `app.onError` 根据请求上下文是否存在 `api_format` 渲染对应格式的错误响应。

---

## 2. 用户角色与身份模型

系统共有三类用户角色（定义于 `UserType`）：

| 角色 | 存储位置 | 租户归属 (`tenant_id`) | 权限范围 |
|------|----------|------------------------|----------|
| `ROOT` | 环境变量 `ROOT_TOKEN`（虚拟用户，`id = -1`） | 无固定归属（缺省 `main`） | 最高权限：可访问所有管理端接口、跨租户切换视角、执行全局孤儿数据清理、调用 LLM API（无限余额） |
| `ADMIN` | 数据库 `user` 表（`type = "admin"`） | 归属特定租户 | 管理端权限 + LLM API 调用权限；其中归属 `main` 租户的 `ADMIN` 具备系统管理员（`isSystemAdmin`）权限 |
| `NORMAL` | 数据库 `user` 表（`type = "normal"`） | 归属特定租户 | 仅可调用 LLM API（`/llm/v1/*`），不可访问管理端接口 |

### 2.1 系统管理员（`isSystemAdmin`）
在租户作用域解析阶段，`tenantService` 会计算 `scope.isSystemAdmin`：
```ts
isSystemAdmin = user.type === UserType.ROOT
             || (user.type === UserType.ADMIN && user.tenant_id === mainTenantId)
```
系统管理员拥有以下跨租户管理能力：
- 租户 CRUD 管理（`/tenant.json`、`/tenant/:id`）；
- 通过 `X-Tenant-ID` 请求头切换到任意已存在的租户视角；
- 修改多租户隔离功能开关（`multi_tenant_enabled`）。

> **例外**：全局悬空数据清理（`/record/clear-orphans/*`）由于操作无 `tenant_id` 列的附属表，严格限制为 `ROOT` 专用（`requireRoot`），不对 `main` 租户 `ADMIN` 开放。

---

## 3. Step 1：身份认证（`userService.authenticateByToken`）

管理端与 LLM 端在提取出原始 Token 字符串后，统一调用 `src/service/userService.ts` 的 `authenticateByToken(token, rootToken, notFoundMessage, errorCode)`：

1. **凭证提取差异**：
   - **管理端（`authMiddleware`）**：仅接受 `Authorization: Bearer <TOKEN>`，缺失或格式不符抛 `401`。
   - **LLM 端（`llmApiMiddleware`）**：同时支持 `Authorization: Bearer <TOKEN>` 与 `x-api-key: <TOKEN>`（同时传入时优先取 `Authorization`），缺失或格式不符抛 `401`（`code = "authentication_error"`）。
2. **Root Token 比对**：
   - 若 `c.env.ROOT_TOKEN` 已配置且非公开占位值（`PLACEHOLDER_ROOT_TOKEN`），对输入 Token 与 `ROOT_TOKEN` 分别做 SHA-256 哈希后执行**恒定时间逐字节比较**（`constantTimeEqualBytes`），防止时序侧信道攻击。
   - 匹配成功则构造虚拟 `SgUser`（`id = -1`、`type = UserType.ROOT`、`balance = Number.MAX_SAFE_INTEGER`）。
3. **普通/管理员用户查库与状态校验**：
   - 未命中 Root Token 时，调用 `userManager.findByToken(token)` 查询数据库：
     - 用户不存在 → 抛 `401`（管理端 `"Invalid token"`，LLM 端 `"Invalid token (user not found)"`）；
     - 用户已禁用（`user.status === UserStatus.DISABLED`）→ 抛 `403 "User disabled"`。

---

## 4. Step 2：租户作用域解析（`tenantService.resolveScopeForUser`）

认证通过后，中间件调用 `src/service/tenantService.ts` 的 `resolveScopeForUser(user, c.req.header("X-Tenant-ID"))` 计算出不可被请求 Body 覆盖的 `TenantScope`，并注入 `c.set("tenantScope", scope)`：

```ts
export interface TenantScope {
    tenantId: number;           // 本次请求生效的目标租户 ID
    mainTenantId: number;       // main 租户 ID（用于联合查询 main 共享模型/规则）
    isSystemAdmin: boolean;     // 是否为系统管理员（ROOT 或 main 租户 ADMIN）
    multiTenantEnabled: boolean;// 多租户隔离开关当前状态
}
```

### 作用域解析规则

| 多租户开关 (`multi_tenant_enabled`) | 请求头 `X-Tenant-ID` | 调用方身份 | 解析结果 / 行为 |
|---|---|---|---|
| **关闭 (`false`)** | 未携带，或指定为 `main` | 任意已认证用户 | 固定落入 `main` 租户（`tenantId = mainTenantId`） |
| **关闭 (`false`)** | 显式指定非 `main` 租户或不存在的租户 | 任意已认证用户 | 抛 `400 "Multi-tenant isolation is disabled"`（不静默回退） |
| **开启 (`true`)** | 未携带 | 系统管理员（`isSystemAdmin = true`） | 缺省落入 `main` 租户 |
| **开启 (`true`)** | 未携带 | 普通管理员 / 普通用户 | 落入用户自身所属租户（`user.tenant_id`） |
| **开启 (`true`)** | 显式指定（支持租户 ID 或名称） | 系统管理员（`isSystemAdmin = true`） | 租户存在则切入该租户视角；不存在则抛 `400 "Tenant not found"` |
| **开启 (`true`)** | 显式指定（支持租户 ID 或名称） | 非系统管理员 | 若目标租户不存在抛 `400`；若不等于自身 `user.tenant_id` 则抛 `403 "Tenant mismatch..."` |

---

## 5. Step 3：路由守卫中间件（`src/middleware/`）

`src/routes.ts` 中每条受保护路由显式挂载 **1 个** 守卫中间件，不再使用顶层通配前缀双挂。

### 5.1 管理端守卫（`src/middleware/authMiddleware.ts`）

所有管理端守卫内部均先调用 `authenticateAdminWithScope(c)` 完成：
1. 提取 `Bearer` Token 并调用 `userService.authenticateByToken`；
2. 校验 `user.type` 必须为 `ADMIN` 或 `ROOT`（否则抛 `403 "Admin access required"`）；
3. 调用 `tenantService.resolveScopeForUser` 并在 Context 中注入 `user` 与 `tenantScope`。

在此基础上提供 4 个守卫：

| 守卫方法 | 附加校验条件 | 挂载路由范围 |
|---|---|---|
| `authMiddleware.requireAdmin` | 无附加条件（凡 `ADMIN` / `ROOT` 均放行，按各自 `tenantScope` 隔离数据） | `/status.json`、`/update.json`、`GET /config.json`、`/vendor/*`、`/model/*`、`/user/*`、`/rule/*`、`/balance/*`、`/record/*`（除孤儿清理外）、`/stats/*` |
| `authMiddleware.requireMainView` | 要求当前视角为 `main` 租户（`scope.tenantId === scope.mainTenantId`），否则抛 `403 "This endpoint is only available in the main tenant scope"` | `PUT /config.json`、`/client-config/*` |
| `authMiddleware.requireSystemAdmin` | 要求 `scope.isSystemAdmin === true`，否则抛 `403 "System administrator access required"` | `/tenant.json`、`/tenant/:id`（`tenantController` 内保留 `assertSystemAdmin` 双保险） |
| `authMiddleware.requireRoot` | 要求 `user.type === UserType.ROOT`，否则抛 `403 "Root access required"` | `/record/clear-orphans/stats.json`、`/record/clear-orphans/step`（`recordController` 内保留 `assertRoot` 双保险） |

### 5.2 LLM 端守卫（`src/middleware/llmApiMiddleware.ts`）

LLM 端守卫在路由挂载时显式接收客户端协议格式 `ApiFormat`（`OPENAI` / `ANTHROPIC` / `RESPONSES`），在进入中间件第一行调用 `c.set("api_format", format)`，随后通过内部公共函数 `authenticateAndResolveScope(c, format)` 完成 Step 1（`Bearer` / `x-api-key` 认证）与 Step 2（`tenantScope` 解析）。

对外提供 2 个路由守卫：

| 守卫方法 | 职责说明 | 挂载路由 |
|---|---|---|
| `llmApiMiddleware.requireLlmAuth(format)` | 仅执行 Step 1（认证）+ Step 2（租户作用域解析），不读取请求体、不解析模型 | `GET /llm/v1/models` |
| `llmApiMiddleware.requireModelAccess(format)` | 执行 Step 1 + Step 2 后，继续执行 Step 3 模型调用准入检查：<br>1. **请求体大小限制**：读取配置 `llm_max_body_bytes`（默认 32MB），先校验 `Content-Length` 响应头快速拒绝，再校验实读 `body.length`，超限抛 `413`；<br>2. **模型解析**：解析 JSON Body 中的 `model` 参数，调用 `llmRequestService.resolveContext` 查找启用模型（或按直连开关构造临时模型），注入 `requestBody` 与 `modelConfig`；<br>3. **阶段一规则检查**：调用 `ruleService.matchAndCheck(user, modelConfig, scope)` 检查不含 `vendor_id` 的访问控制（403）与限流（429）规则，被拦截时落库失败记录并抛出异常 | `POST /llm/v1/chat/completions`<br>`POST /llm/v1/messages`<br>`POST /llm/v1/responses` |

---

## 6. 错误响应协议适配（`app.onError`）

管理端与 LLM 端共用同一套异常类（`customError.AppError` 及其子类），但客户端期望的错误响应结构不同。适配逻辑集中在 `src/routes.ts` 的 `app.onError`：

1. **LLM 端请求（`c.get("api_format")` 已由 `llmApiMiddleware` 注入）**：
   - 调用 `customError.buildLlmErrorResponse(err, apiFormat)`，将异常转换为对应协议的标准结构：
     - **OpenAI / Responses 格式**：`{ error: { message, type, param: null, code } }`
     - **Anthropic 格式**：`{ type: "error", error: { type, message } }`
   - 若 `error.code === "rate_limit_error"`（429），自动附加 `Retry-After` 响应头。
2. **管理端请求（`c.get("api_format")` 未设置）**：
   - 已知业务异常（带 `statusCode`）：返回 `{ error: message, code }`；
   - 未知内部异常（500）：屏蔽内部堆栈细节，生成唯一 `request_id` 写入服务端日志，向客户端返回 `{ error: "Internal server error", message: "Internal server error", request_id }`。
