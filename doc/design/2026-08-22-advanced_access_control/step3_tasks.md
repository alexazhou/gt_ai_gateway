# 网关请求规则（规则化：限流 + 访问控制）- 开发任务表

> 状态：规划中（尚未实施）

## 任务概览

任务按依赖排序：先落常量/迁移与 scope 表达式树（任务 1-3，其中 3 是纯逻辑可先行），再做计数器与 `rateLimitService`（任务 4），收敛 ruleService 编排（任务 5），随后接入两个执行点（任务 6）与错误响应（任务 7），补规则 CRUD API（任务 8）与前端页面（任务 9），最后全量测试回归（任务 10）。

> 状态标记：`[x]` 已完成，`[ ]` 待完成 / 待验证。

---

## 任务列表

### 任务 1: 常量与迁移

**描述**: 新增规则类型枚举、失败码及 `rule` 表迁移，供后续任务引用。

**依赖**: 无

**核心文件**:
- `src/constants.ts`
- `resource/migrate/migrate_0031/`

**子任务**:
- [ ] `RuleType` 枚举：`RATE_LIMIT = "rate_limit"`、`ACCESS_CONTROL = "access_control"`
- [ ] `FailedCode` 新增：`RATE_LIMIT_EXCEEDED = "rate_limit_exceeded"`、`ACCESS_DENIED = "access_denied"`
- [ ] 新建 `migrate_0031`（`mysql.sql` + `sqlite.sql`）：`rule` 表（id / type / name / scope TEXT / config TEXT / enabled / created_at / updated_at），worker D1 走 sqlite 方言

**验收标准**:
- 迁移在 node（SQLite / MySQL）与 worker（D1）三种形态下均可正确执行；`rule` 表可正常读写

### 任务 2: 数据模型与 DAL

**描述**: `sgRule` 模型（scope/config JSON cast）与 `ruleManager`（CRUD + 内存规则缓存失效）。

**依赖**: 任务 1

**核心文件**:
- `src/model/sgRule.ts`
- `src/manager/ruleManager.ts`

**子任务**:
- [ ] `sgRule`：`scope` / `config` 序列化为 TEXT，读时 JSON.parse
- [ ] `ruleManager.listEnabled()`：仅启用规则，供 ruleService 回源
- [ ] `ruleManager` CRUD：`findById` / `create` / `update` / `delete`
- [ ] CRUD 后通知 ruleService 失效规则内存缓存（删除/修改即时生效）

**验收标准**:
- 单测覆盖 CRUD 与 JSON 字段 round-trip；缓存失效回调被调用

### 任务 3: scope 表达式树

**描述**: 统一节点结构 `{ type, oper?, values }` 的类型、求值与校验。

**依赖**: 无（纯逻辑，可与任务 1/2 并行）

**核心文件**:
- `src/util/rule/types.ts`
- `src/util/rule/scopeExpr.ts`

**子任务**:
- [ ] `types.ts`：`ScopeField`、`ScopeOperator`、`ScopeNodeType`、`LeafNode` / `LogicNode` / `ConstNode` / `ExprNode`、`RequestContext`
- [ ] `matchCondition(actual, leaf)`：`=`/`!=` 取 `values[0]`，`in`/`not in` 用 `values`（number[]）
- [ ] `evalExpr(node, ctx)`：按 `type` 分发——`and` 全真、`or` 任一真、`const` 恒真、叶子按维度取 `ctx[node.type]` 匹配
- [ ] `exprReferencesVendor(node)`：`and`/`or` 递归子节点，叶子判 `type === "vendor_id"`，`const` 返回 false
- [ ] `validateScope(node)`：`type` ∈ 合法集；叶子 `oper` ∈ 合法集、`values` 为 number[]（`=`/`!=` 单元素、`in`/`not in` 非空）；`and`/`or` 的 `values` 非空子节点数组；`const` 的 `values` 必须为 `[true]`；树深度 ≤ 8

**验收标准**:
- 单测覆盖：`=`/`!=`/`in`/`not in` 四运算符、`const` 恒真、AND/OR 嵌套、空 and/or 校验拒绝、`exprReferencesVendor` 分流判定

### 任务 4: 计数器与 rateLimitService

**描述**: 内存滑动窗口计数器 + 限流执行接口（`rateLimitService`）+ 错误类。

**依赖**: 任务 1、3

**核心文件**:
- `src/util/rule/memoryRateLimitStore.ts`
- `src/service/rateLimitService.ts`
- `src/customError.ts`

**子任务**:
- [ ] `RateLimitStore` 接口：`incr(key, now): number`（先加后判，返回加权计数）
- [ ] `memoryRateLimitStore`：60s 滑动窗口 + 当前/上一分钟两桶加权插值，`weighted >= limit` 判定；键按（规则数 × 2 分钟窗口）有界，每分钟定时清扫陈旧键
- [ ] `customError.ts` 新增 `RateLimitError extends AppError`：`statusCode = 429`、`code = "rate_limit_error"`、`retryAfterSeconds`、可选 `failoverEligible` 标记
- [ ] `customError.ts` 新增 `AccessDeniedError extends AppError`：`statusCode = 403`、`code = "access_denied"`
- [ ] `rateLimitService.checkAndAdmit(rule, ctx, opts?)`：`config.rpm` 为 `null`/缺省 → 放行；为 `0` → 直接抛 `RateLimitError`（不可用）；`> 0` → `store.incr` 后超限抛 `RateLimitError`
- [ ] `opts.failoverEligible` 透传到抛出的 `RateLimitError`（阶段二传入 `true`）

**验收标准**:
- 单测覆盖：窗口滚动、加权计算、原子自增；rpm `null` / `0` / 正整数三种取值判定；`failoverEligible` 标记正确透传

### 任务 5: ruleService 编排

**描述**: 规则内存缓存 + 匹配编排（access_control 拒绝 + 委托 `rateLimitService` 限流）+ root 旁路 + 失败记录，对外暴露阶段一/阶段二两个入口。

**依赖**: 任务 2、3、4

**核心文件**:
- `src/service/ruleService.ts`（依赖 `rateLimitService`）

**子任务**:
- [ ] 规则内存缓存：首次访问回源 `ruleManager.listEnabled()`，CRUD 时失效；加 TTL（如 60s）兜底 worker 多 isolate 的跨实例缓存过期
- [ ] 按 `exprReferencesVendor` 将启用规则分为「不含 / 含 vendor_id」两组
- [ ] `matchAndCheck(user, modelConfig)`（阶段一）：跑「不含 vendor_id」组，对命中的 `access_control` 规则抛 `AccessDeniedError`（403），对命中的 `rate_limit` 规则逐个调 `rateLimitService.checkAndAdmit`；`user.type === ROOT` 直接返回
- [ ] `matchAndCheckVendor(user, modelConfig, vendor)`（阶段二）：跑「含 vendor_id」组，`vendor.id` 填入上下文后执行，`rateLimitService.checkAndAdmit` 传 `failoverEligible = true`；root 旁路
- [ ] 被拒（403/429）时调用 `recordService.recordFailedRequest(...)`（阶段一），`failed_code` = `access_denied` / `rate_limit_exceeded`

**验收标准**:
- 单测覆盖：树求值匹配、deny-wins（多 access_control 任一命中即拒）、root 旁路、access_control 先于 rate_limit、限流正确委托 `rateLimitService`、两阶段 vendor_id 分流

### 任务 6: 接入点（阶段一 + 阶段二 + failover）

**描述**: 在请求链路接入两个执行点，含供应商级限流 failover 与 inspect 模式跳过。

**依赖**: 任务 5

**核心文件**:
- `src/middleware/llmApiMiddleware.ts`（`requireLlmRequestContext`，`c.set("modelConfig", ...)` 之后）
- `src/service/senderService.ts`（`sendRequest` 路由循环：`selectUpstream` 之后、`sendRequestToUpstream` 之前）

**子任务**:
- [ ] 阶段一：`llmApiMiddleware` 在 `c.set("modelConfig", modelConfig)` 后、`await next()` 前调用 `ruleService.matchAndCheck(user, modelConfig)`；被拒时 `recordFailedRequest`（此时 user/modelConfig/requestBody 均在 context）
- [ ] 阶段二：`sendRequest` 路由循环内，`selectUpstream` 返回上游后、`sendRequestToUpstream` 前调用 `ruleService.matchAndCheckVendor(user, modelConfig, vendor)`
- [ ] inspect 模式跳过：`options.inspect === true` 时跳过阶段二（route-test 纯诊断，不计数、不受限）
- [ ] 阶段二 `AccessDeniedError`：将已创建 record 标记 `FAILED`（`failed_code = access_denied`）后抛出，交给 onError 渲染 403，不 failover
- [ ] 阶段二 `RateLimitError(failoverEligible)`：在路由循环 catch 中视为「该上游繁忙」——failover 开启时存入 `lastFailure` 并 `continue`（`selectUpstream` 已 `markTried` 自动跳过该上游）；failover 关闭或全部耗尽时返回 429（返回前 record 标记 `FAILED`，`failed_code = rate_limit_exceeded`）
- [ ] 阶段二 429 复用与 onError 一致的协议错误体与 `Retry-After`（建议：全部耗尽时重新抛出 `RateLimitError` 交给 onError 统一渲染）

**验收标准**:
- 三个 LLM 端点共用中间件，阶段一全覆盖；供应商级限流命中时 route-test 不受影响、真实请求可切换到其它供应商、全部耗尽回 429；阶段二 403/429 均留下 FAILED 记录

### 任务 7: 错误响应（429 + Retry-After）

**描述**: 429/403 三协议错误体与 `Retry-After` 头。

**依赖**: 任务 4

**核心文件**:
- `src/customError.ts`（`buildLlmErrorResponse`）
- `src/routes.ts`（`onError`）

**子任务**:
- [ ] `buildLlmErrorResponse` 补充 429 → `rate_limit_error` 映射（或依赖 `err.code`）；**不改** `403 → authentication_error` fallback（`AccessDeniedError` 已显式设 `code = "access_denied"`，优先用 `err.code`）
- [ ] `routes.ts` `onError` 识别 `code === "rate_limit_error"` 时 `c.header("Retry-After", "60")` 后再返回错误体（固定 60s，客户端等满一个窗口重试）

**验收标准**:
- 三协议（OpenAI / Anthropic / Responses）429 与 403 错误体格式正确，429 带 `Retry-After`；现有鉴权 403 行为不变

### 任务 8: 规则 CRUD API

**描述**: 规则的增删改查接口 + 按 type 校验。

**依赖**: 任务 2、3

**核心文件**:
- `src/controller/ruleController.ts`
- `src/routes.ts`
- `src/service/ruleService.ts`（校验入口）

**子任务**:
- [ ] `ruleController`：`list`（分页 + keyword）/ `get` / `create` / `update` / `delete`
- [ ] 校验：`type` 已注册；`scope` 用 `validateScope`；`rate_limit` 的 `config.rpm` 为非负整数或 `null`；`access_control` 的 `config` 必须为空 `{}`
- [ ] `routes.ts` 注册（`authMiddleware.requireAdmin`）：`GET /rule/list.json`、`GET /rule/:id`、`POST /rule/create.json`、`PUT /rule/:id`、`DELETE /rule/:id`
- [ ] 删除/修改后内存缓存即时失效（经 ruleManager 通知）

**验收标准**:
- CRUD 可用；非法 scope（空 and/or、`=`/`!=` 多值、`const` 非 `[true]` 等）与非法 config 被拒绝；改动即时生效

### 任务 9: 前端规则管理页

**描述**: 规则列表 + 新增/编辑对话框（条件树编辑器 + 按 type 渲染 config）。

**依赖**: 任务 8

**核心文件**:
- `src/types/rule.ts`
- `src/api/rule.ts`
- `src/views/Rule/`（Index / List / 对话框）
- 侧边栏入口

**子任务**:
- [ ] `types/rule.ts`：`Rule`、`ExprNode`（LeafNode / LogicNode / ConstNode）、`RuleType`、`RuleConfig`
- [ ] `api/rule.ts`：CRUD 请求封装
- [ ] 规则列表页（复用 `useTable`）+ 新增/编辑对话框：名称、启用开关、type、scope **条件树编辑器**、按 type 渲染 config 表单
- [ ] 条件树编辑器：叶子行（维度 user/model/vendor + 运算符 + 取值）与「+ AND / + OR 分组」嵌套，提供「全部匹配」节点（渲染为恒真 `{ "type": "const", "values": [true] }`）
- [ ] `rate_limit` 渲染 rpm 输入（`0` = 不可用 / 空 = 不限制），`access_control` 无 config
- [ ] 侧边栏「规则」入口

**验收标准**:
- 规则管理页可用（列表 + 增删改），树编辑器生成的 scope 结构合法；前端构建通过

### 任务 10: 测试与回归

**描述**: 集成/API 测试与全量回归。

**依赖**: 任务 6、7、8、9

**核心文件**:
- 测试 mock AI 服务器（`doc/dev/TestManual.md`）
- 对应 service / controller / middleware 测试文件

**子任务**:
- [ ] 集成测试：规则 CRUD；命中限流规则后 429 + `Retry-After`；命中访问控制规则后 403；三协议错误体（429 与 403）
- [ ] 供应商级限流 failover：mock 两个供应商，一个被限流 → 切换另一供应商成功；全部耗尽 → 回 429
- [ ] inspect 模式（route-test）跳过规则：被限流的供应商在 route-test 下不受影响
- [ ] 429 / 403 失败记录落库（`failed_code` 正确）
- [ ] root 旁路：root token 请求不受规则影响
- [ ] 零回归：未配置规则时请求行为与迭代前一致
- [ ] `npm run backend:test:type` 通过；前端构建通过

**验收标准**:
- Node 模式自动化测试全绿，worker 模式留 CI

---

## 依赖关系

```
任务 1 ──┬──> 任务 2 ──┬──> 任务 5 ──> 任务 6
         │             └──> 任务 8 ──> 任务 9
任务 3 ──┴────┬──> 任务 5
              └──> 任务 8
任务 4 ──┬──> 任务 5
         └──> 任务 7
任务 10 <── 任务 6、7、8、9
```
