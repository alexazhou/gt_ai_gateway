# 网关请求规则（规则化：限流 + 访问控制）- 技术文档

## 架构概览

规则采用**规则化**设计，一条规则 = 匹配条件（`scope` 表达式树）+ 动作参数（`config`）+ 类型标识（`type`）。请求进入 LLM 入口后，抽出请求上下文，对每棵 `scope` 树求值（`evalExpr`）。**匹配与执行分离**：`ruleService` 负责匹配（并直接处理 access_control 的拒绝），限流执行统一收敛到 service 层的 `rateLimitService`：

- `access_control`（访问控制）：树命中即 403，**先于**限流检查，不随 failover 切换供应商。无状态，由 `ruleService` 匹配后直接拒绝。
- `rate_limit`（限流）：匹配出的规则交由 `rateLimitService.checkAndAdmit` 执行——RPM 准入计数（先加后判），超限 → 429。本期仅 RPM。

```
请求 → authMiddleware(鉴权)
     → llmApiMiddleware(解析 user + model)
        ├─ 抽取请求上下文 { user_id, model_id }
        ├─ 【阶段一：路由前】匹配不含 vendor_id 的启用规则
        │   ├─ 命中的 access_control 规则 → 403（记失败记录）
        │   └─ 命中的 rate_limit 规则 → rateLimitService.checkAndAdmit（RPM 自增 → 超限抛 429，记失败记录）
        └─ 通过
     → gatewayController → senderService（路由循环）
        ├─ routingService.selectUpstream（选择上游，确定实际 vendor_id）
        ├─ 【阶段二：路由后、调用上游前】匹配含 vendor_id 的启用规则
        │   ├─ 命中的 access_control 规则 → 403（记 FAILED，不 failover）
        │   └─ 命中的 rate_limit 规则 → rateLimitService.checkAndAdmit（RPM 自增 → 超限视为「该上游繁忙」，
        │       failover 开启时切换下一上游，全部耗尽 / 关闭时返回 429）
        └─ sendRequestToUpstream → 上游 → responseHandlerService
```

分层沿用既有约定：`controller → service（业务编排） → manager（DAL） → model`。

## 数据模型

新增单表 `rule`，`scope` / `config` 用 JSON 列以最大化扩展性（未来加维度 / 加规则类型不改表）：

```sql
-- mysql.sql
create table `rule`
(
    id         BIGINT                              not null auto_increment primary key,
    type       VARCHAR(32)                         not null,
    name       VARCHAR(255)                        not null default '',
    scope      TEXT                                not null,
    config     TEXT                                not null,
    enabled    INTEGER                             not null default 1,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;

-- sqlite.sql（worker/D1 复用 sqlite 方言）
create table rule
(
    id         INTEGER                             not null constraint rule_pk primary key autoincrement,
    type       TEXT                                not null,
    name       TEXT                                not null default '',
    scope      TEXT                                not null,
    config     TEXT                                not null,
    enabled    INTEGER                             not null default 1,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);
```

迁移新增 `migrate_0031`（注意：`migrate_0030` 已被 model/client_config 索引改造占用），按现有规范提供 `mysql.sql` 与 `sqlite.sql` 两份（worker 走 sqlite 方言）。

### 规则结构

```jsonc
// type = "rate_limit"（模型组共享限流额度）
{
  "type": "rate_limit",
  "name": "gpt 系列模型级限流",
  "enabled": true,
  "scope": { "type": "model_id", "oper": "in", "values": [5, 6, 7] },
  "config": { "rpm": 100 }
}

// type = "rate_limit"（供应商级限流：所有走供应商 9 的模型共享额度）
{
  "type": "rate_limit",
  "name": "供应商 9 总限流",
  "enabled": true,
  "scope": { "type": "vendor_id", "oper": "=", "values": [9] },
  "config": { "rpm": 500 }
}

// type = "access_control"（白名单：模型 5 仅用户 3/4/5 可调用）
{
  "type": "access_control",
  "name": "gpt-4o 仅内部用户可用",
  "enabled": true,
  "scope": { "type": "and", "values": [
      { "type": "model_id", "oper": "=", "values": [5] },
      { "type": "user_id",  "oper": "not in", "values": [3, 4, 5] }
  ]},
  "config": {}
}

// 未来：type = "concurrency"，config 结构互不影响
{
  "type": "concurrency",
  "scope": { "type": "model_id", "oper": "=", "values": [5] },
  "config": { "max_concurrent": 10 }
}
```

- `type` 为开放字符串，内置 `rate_limit`、`access_control`，未来按需注册新类型（`concurrency` / `cost_quota` 等）。
- `scope` 为**布尔表达式树**，所有节点统一为 `{ type, oper?, values }` 结构：`type` 为节点类型（叶子维度 `user_id` / `model_id` / `vendor_id`、组合 `and` / `or`、恒真 `const`）；`oper` 仅叶子携带；`values` 为取值列表（叶子为比较值、`and` / `or` 为子节点列表、`const` 为 `[true]`）。`and` / `or` 的 `values` 必须**非空**（空数组不合法，避免歧义）。恒真节点 `{ "type": "const", "values": [true] }` 用于全局兜底规则（所有请求命中）。
- `config` 结构由 `type` 定义：
    - `rate_limit`：`{ rpm }`（`null` / 缺省 = 不限制；`0` = 不可用，所有命中请求 429）。本期仅 RPM，TPM 留待后续。
    - `access_control`：无参数（空 `{}`），树命中即拒绝。

## 匹配与生效语义

**表达式树求值**：叶子按运算符判定，`and` 全真、`or` 任一真。三个维度（`user_id`/`model_id`/`vendor_id`）均为标量。含 `vendor_id` 条件的规则在路由选择后执行（见「接入点」）。

```ts
// 节点统一结构 { type, oper?, values }
type ScopeField = "user_id" | "model_id" | "vendor_id";
type ScopeOperator = "=" | "!=" | "in" | "not in";
type ScopeNodeType = ScopeField | "and" | "or" | "const";

// 叶子：type 为判断维度，oper 为运算符，values 为比较值列表（= / != 单元素，in / not in 多元素）
interface LeafNode   { type: ScopeField; oper: ScopeOperator; values: number[] }
// 组合：type 为 and / or，values 为子节点列表（必须非空）
interface LogicNode  { type: "and" | "or"; values: ExprNode[] }
// 恒真：type 为 const，values 固定为 [true]（全命中，全局兜底）
interface ConstNode  { type: "const"; values: [true] }
type ExprNode = LeafNode | LogicNode | ConstNode;

// 请求上下文：vendor_id 仅在路由选择后可用
interface RequestContext {
    user_id: number;
    model_id: number;
    vendor_id?: number;     // 路由选择后填入实际供应商 ID
}

// 所有维度统一标量匹配
function matchCondition(actual: number, node: LeafNode): boolean {
    switch (node.oper) {
        case "=":      return actual === node.values[0];
        case "!=":     return actual !== node.values[0];
        case "in":     return node.values.includes(actual);
        case "not in": return !node.values.includes(actual);
    }
}

function evalExpr(node: ExprNode, ctx: RequestContext): boolean {
    switch (node.type) {
        case "and":   return node.values.every(child => evalExpr(child, ctx));   // 全真（values 非空）
        case "or":    return node.values.some(child  => evalExpr(child, ctx));    // 任一真（values 非空）
        case "const": return true;                                                // values === [true]，全命中
        default:      return matchCondition(ctx[node.type], node);               // 叶子：按维度取值
    }
}

// 辅助：判断表达式树是否引用 vendor_id（用于分流阶段一/阶段二）
function exprReferencesVendor(node: ExprNode): boolean {
    if (node.type === "and" || node.type === "or") {
        return node.values.some(exprReferencesVendor);
    }
    return node.type === "vendor_id";   // const 不引用任何维度
}
```

**生效语义（deny-if-true，两种类型统一）**：

- `rate_limit`：`evalExpr(scope) === true` → 命中 → 施加限流（仅 RPM）。命中的规则**全部同时生效**（任一超限即拒绝；不做优先级 / first-match-wins，未来需要 override 时再加 `priority` 字段）。
- `access_control`：`evalExpr(scope) === true` → 命中 → 抛 `AccessDeniedError`（403）。多规则 fail-closed（deny-wins）。白名单「仅这些用户」用 `not in` 表达。
- **检查顺序**：`access_control` 先于 `rate_limit`，无权限请求不进入限流计数。
- 规则列表做内存缓存（首次回源 DB，CRUD 时失效），避免每请求查库。

## 匹配性能与扩展

规则量级通常几十条，线性遍历 + 每棵树求值已是微秒级，相比秒级的 LLM 请求可忽略。**v1 保持线性扫描**，但把「从启用规则里筛出命中规则」收敛为 `ruleService` 内部一个函数，未来需要时替换成**倒排索引**即可，匹配 / 计数 / 语义全部不动：

- **倒排索引**：把每棵树里的「正条件叶子」（`=`/`in`）拍平，规则挂到对应 ID 下（`byModel` / `byUser` / `byVendor` 三个 Map + `always` 集，`{ "type": "const", "values": [true] }` 等无正叶子 / 无条件规则落入）。查询时取候选并集，只对候选做完整树求值。`or` 会让一条规则挂到多个 ID 下（过度召回但不漏）。
- **命中集缓存（可选）**：LLM 流量高度重复，可用 `user_id:model_id:vendor_ids` 为 key 缓存命中规则 ID 列表，规则 CRUD 时整体失效。只缓存「匹配结果」，不缓存限流计数。

## 计数器：内存滑动窗口（仅 rate_limit）

采用 **60s 滑动窗口 + 当前/上一分钟两桶加权插值**，避免固定窗口在分钟交界的双倍突发：

```
weighted = curCount + prevCount * (1 - elapsed / 60_000)
weighted > limit → 拒绝      // 先加后判：incr 已计入本次请求，超过上限（>）才拒绝
```

- counter key：`rule:{ruleId}:rpm`，一条规则一个独立计数器。
- RPM 准入采用「先加后判」（check + record 一步完成）：自增后即返回加权计数并判定是否**超过**上限。`rpm = N` 恰好放行 N 个请求、第 N+1 个拒绝（与产品文档「滑动窗口内最多 N 个请求」一致）。Node 单进程事件循环内同步读写天然原子，无并发问题。
- 计数器抽象为 `RateLimitStore` 接口（本期仅内存实现，接口预留以便后续切 DB / Durable Object；未来新增 TPM 等指标时再扩展 `get` / `add`）：

```ts
interface RateLimitStore {
    incr(key: string, now: number): number;            // 自增 1 并返回加权计数（RPM：check + record 一步完成）
}
```

- 键空间按（规则数 × 2 分钟窗口）有界，配一个每分钟定时清扫回收陈旧键（`prevCount` 与 `curCount` 均为 0 且窗口过期即删除）。
- `access_control` 无计数器（纯授权判定，无状态）。

## 限流执行（rateLimitService）

`ruleService` 只负责「匹配出命中的 rate_limit 规则」，限流动作（RPM 计数 + 429 判定）统一收敛到 service 层的 `rateLimitService`，对外提供限流接口：

```ts
interface RateLimitService {
    // 准入：RPM 先加后判（check + record 一步完成），超限抛 RateLimitError
    checkAndAdmit(rule: SgRule, ctx: RequestContext, opts?: { failoverEligible?: boolean }): Promise<void>;
}
```

`rateLimitService.checkAndAdmit` 逻辑：
- `config.rpm` 为 `null` / 缺省 → 直接放行（不限制）；为 `0` → 直接抛 `RateLimitError`（无请求额度，不可用）；为 `N > 0` → `store.incr("rule:{id}:rpm")` 后判定是否超限（先加后判，RPM check + record 一步完成），超限抛 `RateLimitError`。
- 阶段二调用时传 `opts.failoverEligible = true`，抛出的 `RateLimitError` 带 failover 标记（见「接入点·阶段二」）。

`access_control` 无状态（纯授权判定，无计数器），不单独成 service，由 `ruleService` 匹配后直接处理：树命中即抛 `AccessDeniedError`（403）。未来新增规则类型（如 `concurrency`）时，在 `ruleService` 增加对应处理分支（或独立 service）即可。

## 代码结构

```
src/service/ruleService.ts                  # 规则匹配（scope 树求值）、命中规则缓存、access_control 拒绝、编排限流、root 旁路、抛 403/429
src/service/rateLimitService.ts             # 限流执行：RPM 计数（RateLimitStore）、超限抛 429；对外提供 checkAndAdmit
src/manager/ruleManager.ts                  # DAL：rule CRUD + 内存规则缓存失效
src/model/sgRule.ts                         # rule 模型（scope/config JSON cast）
src/util/rule/
  ├── types.ts                              # RateLimitStore、RequestContext、ExprNode、ScopeField 类型
  ├── memoryRateLimitStore.ts               # 内存滑动窗口实现（仅 incr）
  └── scopeExpr.ts                          # 表达式树求值 evalExpr / matchCondition / exprReferencesVendor / validateScope
src/constants.ts                            # 新增 RuleType 枚举（RATE_LIMIT / ACCESS_CONTROL）
```

- `ruleService` 维护规则内存缓存：首次访问时回源 `ruleManager.listEnabled()`，CRUD 时 `ruleManager` 通知失效。规则按 `exprReferencesVendor` 分为两组（不含 / 含 vendor_id），分别在路由前后检查。
- `ruleService.matchAndCheck`（阶段一）：筛选不含 vendor_id 的规则，逐条对命中的 `access_control` 规则抛 `AccessDeniedError`（403），再对命中的 `rate_limit` 规则逐个调 `rateLimitService.checkAndAdmit`（超限抛 429）。RPM 在准入时一步完成、无请求后记账，故无需向上下文传递命中规则。
- `ruleService.matchAndCheckVendor`（阶段二）：筛选含 vendor_id 的规则，补充 `vendor_id` 到上下文后执行，逻辑同上，`rateLimitService.checkAndAdmit` 传 `failoverEligible = true`；在路由循环内、调用上游前调用。
- 命名/导入遵循项目规范：默认导出、`模块名.方法名`。

## 执行点与规则分流

### 执行点总览

规则的检查分散在请求生命周期的三个执行点。每条规则**只在一个阶段被检查**（按 scope 是否引用 `vendor_id` 分流），请求需在所有经过的阶段都未命中任何拒绝规则才放行：

| 阶段 | 时机 | 位置 | 检查什么 |
|------|------|------|----------|
| **阶段一：路由前** | 鉴权 + 模型解析完成、进入路由前（拦截成本最低） | `llmApiMiddleware.requireLlmRequestContext` | 不含 `vendor_id` 的启用规则：`access_control` 命中→403、`rate_limit` 命中→429（先加后判） |
| **阶段二：路由后** | 每次选出上游后、调用上游前（**每次尝试各查一次**） | `senderService.sendRequest` 路由循环内 | 含 `vendor_id` 的启用规则：`access_control` 命中→403（不 failover）、`rate_limit` 命中→429（触发 failover 换上游） |
| **阶段三：响应后** | 上游成功响应后 | `responseHandlerService` | 本期无（原为 TPM 事后记账，已推迟到后续版本） |

阶段推进与约束：

- 阶段一 → 阶段二 → 上游，逐级递进；**任一级拒绝即终止**，后续阶段不再执行。
- 每个阶段内 `access_control` **先于** `rate_limit`，无权限请求不消耗限流计数。
- root 用户在所有阶段直接旁路（不匹配、不计数）。
- 阶段二随 failover 每次尝试各执行一次（`selectUpstream` 选出新上游后），供应商级限流按「实际尝试次数」累计。

### 规则 → 阶段分流

规则归属哪个阶段由 scope 树是否引用 `vendor_id` 决定（`exprReferencesVendor` 自动分流，用户无感知）：

| scope 形态 | 是否引用 vendor_id | 检查阶段 |
|------------|-------------------|----------|
| 叶子 / 组合节点只涉及 `user_id`、`model_id` | 否 | **阶段一**（路由前） |
| 恒真 `{ "type": "const", "values": [true] }`（全局兜底） | 否（不引用任何维度） | **阶段一**（路由前） |
| 任一节点引用 `vendor_id`（含混合条件，如 `model_id=5 AND vendor_id=9`） | 是 | **阶段二**（路由后，此时实际供应商已确定） |

同一规则在所在阶段按行为执行（access_control 命中即拒 / rate_limit 交由 `rateLimitService` 判定），命中行为差异仅取决于所在阶段：

| 规则 type | 阶段一命中 | 阶段二命中 |
|-----------|-----------|-----------|
| `access_control` | 403，拒绝 | 403，拒绝（**不 failover**，策略性拒绝与供应商无关） |
| `rate_limit` | 429，拒绝 | 429，视为「该上游繁忙」：failover 开启时切换下一上游，全部耗尽 / 关闭才回 429 |

常见规则示例：

| 规则 | scope | 阶段 | 命中行为 |
|------|-------|------|----------|
| 模型级限流 | `model_id = 5` | 阶段一 | RPM 超限 → 429 |
| 全局兜底限流 | `{ "type": "const", "values": [true] }` | 阶段一 | 对所有非 root 请求施加统一限流 |
| 供应商级限流 | `vendor_id = 9` | 阶段二 | 路由到 9 时检查，超限 → failover 到其它供应商 |
| 模型×供应商访问控制 | `model_id=5 AND vendor_id=9` | 阶段二 | 命中 → 403，不 failover |

## 接入点（实现细节）

### 阶段一：路由前准入检查

`src/middleware/llmApiMiddleware.ts` 的 `requireLlmRequestContext` 中，`c.set("modelConfig", modelConfig)` 之后、`await next()` 之前：

```ts
// 阶段一：仅检查不含 vendor_id 的规则（此时尚未路由，vendor_id 未知）
await ruleService.matchAndCheck(user, modelConfig);
```

此时 `user`（含 id、type）与 `modelConfig`（含 id）均已解析，且尚未进入路由，拦截成本最低；三个 LLM 端点共用同一中间件，天然全覆盖。`matchAndCheck` 内部：筛选 scope 不引用 `vendor_id` 的启用规则，先对命中的 `access_control` 规则抛 403，再对命中的 `rate_limit` 规则逐个调 `rateLimitService.checkAndAdmit`（超限抛 429）。root 用户在此直接旁路（不匹配、不计数）。

阶段一被拒（403/429）时调用 `recordService.recordFailedRequest(user.id, modelConfig.name, body, format, failedCode, modelConfig.id)` 写入一条失败记录（`failed_code` = `access_denied` / `rate_limit_exceeded`），此时 `user`、`modelConfig`、`requestBody` 均已在 context 中。

### 阶段二：路由后准入检查

位于 `senderService.sendRequest` 的路由循环内、`sendRequestToUpstream` 调用之前（每次选出的上游都检查一次）。此时已确定实际路由到的供应商 `vendor.id`，补充到请求上下文后对含 `vendor_id` 的规则求值。处理逻辑与阶段一一致（access_control 先于 rate_limit）。

```ts
// 阶段二：检查含 vendor_id 的规则（路由选择后，vendor_id 已确定）
// 403 / 429 由 ruleService 直接抛出；RPM 在准入时一步完成，无需带回 context
await ruleService.matchAndCheckVendor(user, modelConfig, vendor);
```

两种拒绝的差异处理（在路由循环的 catch 中区分）：

- **`AccessDeniedError`（403，deny-wins）**：**不 failover**——策略性拒绝与供应商无关，直接抛出让 `onError` 返回 403；同时将本请求已创建的 record 标记 `FAILED`（`failed_code` = `access_denied`）。
- **`RateLimitError`（429，供应商级）**：视为「该上游繁忙」，走现有 failover 机制——`selectUpstream` 选中上游时已 `markTried`，`continue` 后会自动尝试下一上游；failover 开启时把 429 存入 `lastFailure` 继续循环，failover 关闭或全部上游耗尽时返回 429（返回前将 record 标记 `FAILED`，`failed_code` = `rate_limit_exceeded`）。供应商级限流不会阻塞模型仍可用的其它供应商。

**inspect 模式（路由测试）跳过**：`/model/route-test.json` 以 `{ inspect: true }` 调用 `sendRequest`，此模式跳过阶段二规则检查——route-test 是纯诊断，不受限流 / 访问控制影响，也不计入 RPM。阶段一因 route-test 绕过 `llmApiMiddleware` 本就未执行，因此规则只约束真实 `/llm/v1/*` 流量。

### Token 记账（本期无）

本期仅 RPM 限流，RPM 在准入时「先加后判」一步完成，**无请求后记账环节**，`responseHandlerService` 无需改动。TPM（token 限流）留待后续版本，届时再在 `finalizeStreamResult` / `handleNonStreamResponse` 两个成功收尾点补充。

## API 接口定义

沿用 rest 风格与 `.json` 结尾约定，需管理员权限（`authMiddleware.requireAdmin`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/rule/list.json` | 规则列表（分页 + keyword） |
| GET | `/rule/:id` | 单条规则 |
| POST | `/rule/create.json` | 新增规则 |
| PUT | `/rule/:id` | 修改规则 |
| DELETE | `/rule/:id` | 删除规则 |

请求体（create / update）：

```jsonc
// rate_limit
{ "type": "rate_limit", "name": "gpt 系列限流", "enabled": true,
  "scope": { "type": "or", "values": [
      { "type": "model_id", "oper": "in", "values": [5, 6, 7] }
  ]},
  "config": { "rpm": 100 } }

// access_control（白名单）
{ "type": "access_control", "name": "gpt-4o 仅内部用户", "enabled": true,
  "scope": { "type": "and", "values": [
      { "type": "model_id", "oper": "=", "values": [5] },
      { "type": "user_id",  "oper": "not in", "values": [3, 4, 5] }
  ]},
  "config": {} }
```

校验（按 `type` 分派）：
- `type` 必须为已注册类型。
- `scope` 必须为合法表达式树：所有节点统一为 `{ type, oper?, values }`。`type` ∈ { `user_id`, `model_id`, `vendor_id`, `and`, `or`, `const` }；叶子 `type` 为维度、`oper` ∈ { `=`, `!=`, `in`, `not in` }、`values` 为 number[]（`=`/`!=` 单元素，`in`/`not in` 非空）；`and`/`or` 的 `values` 为非空子节点数组；`const` 的 `values` 必须为 `[true]`；树深度设上限（如 8 层）防滥用。
- `rate_limit`：`config.rpm` 为非负整数或 `null`（`null` = 不限制；`0` = 不可用）。
- `access_control`：`config` 必须为空 `{}`。

## 错误响应（429 + 403）

- 新增 `RateLimitError extends AppError`：`statusCode = 429`、`code = "rate_limit_error"`、携带 `retryAfterSeconds`；供应商级限流抛出的实例带 `failoverEligible` 标记（供路由循环识别，见「接入点·阶段二」）。
- 新增 `AccessDeniedError extends AppError`：`statusCode = 403`、`code = "access_denied"`。
- `src/customError.ts` 的 `buildLlmErrorResponse`：429 走 statusCode fallback 映射为 `rate_limit_error`（或直接使用 `err.code`）；**不修改现有 `403 → authentication_error` 的 fallback**——`AccessDeniedError` 已显式设置 `code = "access_denied"`，`buildLlmErrorResponse` 优先使用 `err.code`，因此无需改 fallback，避免影响现有鉴权 403 的行为。
- `routes.ts` 的 `onError` 识别 `code === "rate_limit_error"` 时先 `c.header("Retry-After", "60")` 再返回错误体（用 code 而非 `instanceof` 识别，保持与现有泛化错误处理一致）；`Retry-After` 采用固定 60 秒——滑动窗口的两桶加权模型不记录单个请求时间戳，无法精确计算剩余等待时间，60s 为保守上限，客户端等满一个窗口再重试成功率最高。
- 错误体复用现有 `buildLlmErrorResponse`，三协议格式：
    - OpenAI / Responses：`{ "error": { "message": "...", "type": "rate_limit_error" | "access_denied", "param": null, "code": "rate_limit_error" | "access_denied" } }`
    - Anthropic：`{ "type": "error", "error": { "type": "rate_limit_error" | "access_denied", "message": "..." } }`

## 前端改动

- 新增 `src/types/rule.ts`：`Rule`、`ExprNode`（LeafNode / AndNode / OrNode）、`RuleType`、`RuleConfig`（按 type 区分 `RateLimitConfig` / `AccessControlConfig`）类型。
- 新增 `src/api/rule.ts`：规则 CRUD 请求封装。
- 新增 `src/views/Rule/`（Index / List / 对话框）：规则列表 + 新增/编辑（名称、启用开关、type、scope **条件树编辑器**、按 type 渲染的 config 表单）。条件树编辑器：叶子行可选维度（用户 / 模型 / 供应商）+ 运算符（`=`/`!=`/`in`/`not in`）+ 取值（标量或逗号分隔 ID 列表），支持「+ AND / + OR 分组」构建嵌套树，并提供「全部匹配」节点（渲染为恒真 `{ "type": "const", "values": [true] }`）；`rate_limit` 的 config 渲染 rpm 输入（`0` = 不可用 / 空 = 不限制），`access_control` 无 config。复用 `useTable` 组合式函数。
- 侧边栏新增「规则」入口；模型/用户对话框**不加字段**（统一走规则）。

## 技术要点与边界

1. **内存限流的取舍**：计数器在进程内存中，worker 多 isolate / MySQL 多实例下为单实例级别、无法跨实例精确限额。`RateLimitStore` 接口已预留，后续可替换为 D1 UPSERT / Durable Object 实现。
2. **本期仅 RPM，无 TPM**：token 限流留待后续；`RateLimitStore` 预留扩展位（届时增加 `get` / `add` 与 Usage 记账）。
3. **rpm 取值语义**：`rpm: null` / 缺省 = 不限制（规则命中但放行）；`rpm: 0` = 不可用（无请求额度，所有命中请求一律 429，可作硬性阻断）；`rpm: N（N > 0）` = 滑动窗口内最多 N 个请求。
4. **并发正确性**：内存侧靠 Node 单线程同步读写保证原子；先加后判为 fail-closed。
5. **失败/中断请求口径**：RPM 在准入时即计数（先加后判），失败/中断请求同样计入；供应商级限流的 failover 每次尝试各计一次。与「无请求后记账」的设计一致。
6. **root 旁路**：`user.type === ROOT` 直接跳过匹配与计数（限流与访问控制一致）。
7. **访问控制判定**：纯授权判定、无状态（无计数器）；先于限流执行；树命中即 403（deny-wins，fail-closed），不随 failover 切换供应商。
8. **表达式树**：仅 AND / OR，无 NOT 节点（叶子级 `!=`/`not in` 覆盖取反）；`and` / `or` 的 `values` 必须**非空**（空数组不合法，避免歧义），全局兜底用显式恒真节点 `{ "type": "const", "values": [true] }`；校验时限制树深度。三个维度均为标量。
9. **`vendor_id` 两阶段检查 + 限流 failover**：含 `vendor_id` 条件的规则在路由选择后执行，匹配实际路由到的供应商（标量）；不含 `vendor_id` 的规则在路由前执行。供应商级限流命中视为「该上游繁忙」，failover 开启时切换下一上游，全部耗尽 / 关闭时返回 429；访问控制命中则直接 403，不 failover。管理员的 route-test（inspect 模式）跳过所有规则检查。
10. **`/llm/v1/models` 不纳入规则**：模型列表既不限流也不按访问控制过滤，访问控制只在调用入口生效。
11. **缓存一致性**：规则内存缓存需在 create/update/delete 时失效，否则改动不生效。在 worker 多 isolate 模式下，规则缓存同样是单 isolate 级别——某个 isolate 上执行 CRUD 只会失效本地缓存，其他 isolate 需等缓存过期才能感知变更。建议给缓存加一个 TTL（如 60s）作为兜底，确保规则变更在可接受延迟内全局生效。
12. **失败留痕**：429 / 403 均写入失败记录（`FailedCode` 新增 `RATE_LIMIT_EXCEEDED = "rate_limit_exceeded"`、`ACCESS_DENIED = "access_denied"`）。阶段一在中间件用 `recordFailedRequest`；阶段二标记已创建 record 为 `FAILED`。便于审计「谁被拒了」与仪表盘排查。
13. **可观测性（可选）**：限流 / 访问拒绝可在 `RequestActivityStage.RESULT` 追加一条失败活动，便于在请求时间线定位拒绝点。

## 测试影响

- 新增单元测试：`scopeExpr`（叶子运算符 `=`/`!=`/`in`/`not in`、`{ "type": "const", "values": [true] }` 恒真节点、AND / OR 嵌套求值、空 and/or 校验拒绝、`exprReferencesVendor` 分流判定）、`memoryRateLimitStore`（窗口滚动、加权计算、原子自增）、`rateLimitService`（rpm `null` / `0` / 正整数三种取值判定、`failoverEligible` 透传）、`ruleService`（树求值匹配、deny-wins、root 旁路、访问控制先于限流、限流委托 rateLimitService、两阶段 vendor_id 规则分流）。
- 新增集成/API 测试：规则 CRUD、命中限流规则后 429 与 `Retry-After`、命中访问控制规则后 403、三协议错误体（429 与 403）、**供应商级限流 failover（切换下一上游 / 全部耗尽回 429）**、429 / 403 失败记录落库。
- 零回归：未配置规则时请求行为不变；复用现有 mock AI 服务器。

## 相关文档

- [产品文档](./step1_product.md)
- [开发任务表](./step3_tasks.md)
