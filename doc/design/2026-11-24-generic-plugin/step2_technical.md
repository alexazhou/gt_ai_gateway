# 通用插件机制技术设计（规则驱动 · 自注册 · 声明式 Patch）

日期：2026-11-24　状态：修订 v2（按 #40 评审 + Operator 决策修订），待实施
修订说明：[revision_notes.md](./revision_notes.md)　实施拆分：[step3_tasks.md](./step3_tasks.md)

## 1. 目标

把 `pluginService` 中三个硬编码 body 改写器升级为通用插件机制，底层统一由规则驱动，同时保留「高级设置 → 请求处理」的三个快捷开关并通过 `biz_id` 联动到系统规则：

| 能力 | 现状 | 目标 |
|---|---|---|
| 扩展方式 | 改 `pluginService` if 分支 | 插件自注册，显式声明 hook 对应方法 |
| 改写方式 | 直接拼改 request body 字符串 | 声明式返回 `jsonPatch`（RFC 6902 子集）+ `headerPatch` |
| 激活方式 | `pluginService` 读 `ConfigKey` | 规则驱动（`RuleType.PLUGIN`，`scope` 条件 + `enabled` 开关） |
| 规则分类与溯源 | 仅普通规则 | 新增字符串枚举 `source`（`RuleSource.SYSTEM` / `RuleSource.USER`）与 `biz_id` 标识规则来源 |
| 系统规则保护 | 无 | `source === "system"` 的规则不允许用户通过规则接口修改（含启用/禁用）和删除 |
| 高级设置联动 | 仅改 `config` 表 | 保留「请求处理」下三个开关，修改设置时按 `biz_id`（`SYS:setting:*`）自动创建/更新对应系统规则的 `enabled` |
| 执行顺序 | 写死 | 插件 `priority` 升序，同插件多规则按 `rule.id` 升序，**全部依次执行** |
| 调用时机 | 转换前 / 转换后 | 显式 hook 方法：`beforeConversion` / `afterConversion` |
| 配置 key 一致性 | tracking 开关前后端 key 不一致（现存 bug） | 统一为后端 `claudecode_tracking_rewrite_enabled` |

## 2. 插件接口（显式 Hook 方法 + 声明式 Patch）

插件不直接就地修改 `body` 或 `headers`，而是接收只读请求视图，返回声明式变更描述（`PluginPatchResult`），由管线统一校验、应用并审计；若当前请求无需修改（如协议不匹配或请求体不含目标结构），直接 `return` 即可跳过：

```ts
// src/plugin/types.ts
export type PluginHook = "before_conversion" | "after_conversion";

/** RFC 6902 JSON Patch 操作（支持 add / replace / remove，path 为 JSON Pointer 如 "/system/0/text"） */
export type JsonPatchOp =
    | { op: "add"; path: string; value: unknown }
    | { op: "replace"; path: string; value: unknown }
    | { op: "remove"; path: string };

/** Header 声明式变更 */
export interface HeaderPatch {
    set?: Record<string, string>;
    remove?: string[];
}

/** 插件单次 Hook 执行返回的声明式补丁；不修改时直接 return 即可 */
export interface PluginPatchResult {
    jsonPatch?: JsonPatchOp[];
    headerPatch?: HeaderPatch;
}

/** 传给插件的只读请求快照（只读为约定 + 单测深冻结兜底，见 §4.3） */
export interface PluginRequestView {
    readonly body: Readonly<Record<string, unknown>>;
    readonly headers: Headers;   // 传入的是副本，插件对其修改无效
}

export interface PluginContext {
    readonly hook: PluginHook;
    /** 客户端请求体中的 model 原值（vendor model 名替换前） */
    readonly clientModel: string;
    readonly clientFormat: ApiFormat;
    readonly upstreamFormat: ApiFormat;
    /** 当前 hook 的协议：before_conversion = clientFormat，after_conversion = upstreamFormat */
    readonly currentFormat: ApiFormat;
    readonly hostKey: string;
    readonly clientName: string | null | undefined;
}

/** 插件自定义配置：来自绑定规则的 config.pluginConfig，缺省归一化为 {} */
export type PluginConfig = Record<string, unknown>;

export type PluginHookHandler = (
    request: PluginRequestView,
    context: PluginContext,
    pluginConfig: PluginConfig,
) => PluginPatchResult | void;

export interface RequestPlugin {
    readonly name: string;
    /** 插件展示名称/说明（供前端规则管理下拉选择展示） */
    readonly description?: string;
    /** 数字越小越先执行 */
    readonly priority: number;
    /** pluginConfig 示例（供前端 JSON 输入框 placeholder 展示，可选；不用于渲染表单） */
    readonly configExample?: PluginConfig;

    readonly beforeConversion?: PluginHookHandler;
    readonly afterConversion?: PluginHookHandler;

    /** 规则保存时校验 pluginConfig（可选）：不合法直接抛 AppError(400)，message 写明具体原因 */
    validateConfig?(pluginConfig: PluginConfig): void;
}
```

### 设计要点
1. **显式注册 Hook 方法**：插件通过实现 `beforeConversion` 和/或 `afterConversion` 显式声明挂载在哪些钩子；方法内部直接检查 `context.currentFormat` 或 `request.body`，不满足条件直接 `return`。`pluginRegistry.register(plugin)` 校验至少实现其中一个方法，且 `name` 唯一、`priority` 为有限数字。
2. **声明式 Patch 替代就地修改**：
   - 返回非空 `jsonPatch` 或 `headerPatch` 且**应用成功**时，才视为实际改写并记入 `executed`；无需修改时 `return;`（或 `{}`），管线静默跳过。
   - 管线在应用前做边界检查（§4.2），违规则**整份补丁拒绝**（以插件执行项为单位原子应用），无需事后快照恢复。
   - `request_activity` 只记录生效的 JSON Pointer 路径与 Header key，不记录内容原文。

## 3. 规则模型扩展：`RuleSource` 枚举、`biz_id` 与高级设置联动

### 3.1 `rule` 表结构扩展
在 `src/constants.ts` 新增：

```ts
export enum RuleType {
    RATE_LIMIT = "rate_limit",
    ACCESS_CONTROL = "forbid_access",
    PLUGIN = "plugin",               // 新增
}

export enum RuleSource {
    SYSTEM = "system",
    USER = "user",
}
```

`rule` 表新增两列：
- `source VARCHAR(32) NOT NULL DEFAULT 'user'`
- `biz_id VARCHAR(128) NULL DEFAULT NULL`，唯一索引 `idx_rule_biz_id`（SQLite/MySQL 中多个 `NULL` 互不冲突）：
  - `SYS:setting:cch_rewrite`
  - `SYS:setting:claudecode_tracking_rewrite`
  - `SYS:setting:responses_prompt_cache_key`
  - 用户规则保持 `NULL`。

```json
{
    "id": 1,
    "biz_id": "SYS:setting:cch_rewrite",
    "source": "system",
    "type": "plugin",
    "name": "强制改写 CCH",
    "scope": { "type": "const", "values": [true] },
    "config": { "plugin": "cchRewriter", "pluginConfig": {} },
    "enabled": true,
    "tenant_id": 1,
    "cross_tenant": true
}
```

| 规则字段 | 职责 |
|---|---|
| `biz_id` | 规则业务来源标识（可空）：系统设置规则为 `SYS:setting:<name>`；用户规则为 `null` |
| `source` | `"system"` = 系统规则（完全只读）；`"user"` = 用户规则（API 创建的规则固定为 `"user"`） |
| `enabled` | 规则启停（系统规则仅由关联的系统设置同步修改） |
| `scope` | 复用 `ExprNode` 表达式树（`user_id` / `model_id` / `vendor_id`） |
| `config.plugin` | 必填，保存时校验必须已在 `pluginRegistry` 注册 |
| `config.pluginConfig` | 选填，校验规则见 §3.5 |

### 3.2 系统规则完全只读保护
- **禁止修改 / 删除**：`ruleManager.update` / `ruleManager.deleteRule` 在现有 `assertWritable`（非属主租户 → 403）之后追加检查：`rule.source === RuleSource.SYSTEM` → `AppError("System rule is read-only", 403)`。统一用 403，与现有共享规则只读口径一致。
- **禁止创建 / 篡改来源**：`createRule` / `updateRule` 忽略请求体中的 `source`、`biz_id` 字段（`updateRule` 的可更新字段白名单不包含这两个字段）；创建时固定写 `source: RuleSource.USER`、`biz_id: null`。
- **内部同步专用入口**：`ruleManager.upsertSystemRuleByBizId(bizId, payload)` 仅供 `configService` 联动和迁移后修复使用，强制 `source: RuleSource.SYSTEM`，按 `biz_id` 查找并创建/更新，完成后 `notifyInvalidate()`。

### 3.3 高级设置三个开关与系统规则联动

**配置 key 统一（Operator 决策 1）**：tracking 开关统一使用后端 `ConfigKey.CLAUDE_CODE_TRACKING_REWRITE_ENABLED = "claudecode_tracking_rewrite_enabled"`。前端 `types/config.ts`、`AdvancedSettings.vue` 的读写字段全部改为 `claudecode_tracking_rewrite_enabled`。旧 key `claude_code_tracking_rewrite_enabled` 的存量值在迁移中合并（§6.2）；为兼容升级窗口内未刷新的旧前端页面，`configService.updateAll` 收到旧 key 时**改写为新 key 再写入**（不再落库旧 key），并打一条 warn 日志。该别名映射作为过渡兼容，后续版本可删除。

映射表：

| `ConfigKey` | 系统规则 `biz_id` | 插件 `name` | 默认规则名称 |
|---|---|---|---|
| `cch_rewrite_enabled` | `SYS:setting:cch_rewrite` | `cchRewriter` | 强制改写 CCH |
| `claudecode_tracking_rewrite_enabled` | `SYS:setting:claudecode_tracking_rewrite` | `claudeCodeTrackingRewriter` | 屏蔽 Claude Code 跟踪 |
| `responses_prompt_cache_key_enabled` | `SYS:setting:responses_prompt_cache_key` | `responsesPromptCacheKeyRewriter` | Responses API 粘性路由 |

**写路径（唯一的落库时机：迁移 + 改设置）**：
1. `configService.setValue(name, value)`（`updateAll` 逐项调用）写入 `config` 表后，若 `name` 属于上表，调用 `ruleService.syncSystemPluginRuleByConfig(key, value === "true")`：
   - 按 `biz_id` 查询；不存在则在 `main` 租户下创建（`source: system`, `type: plugin`, `scope: const true`, `config: { plugin, pluginConfig: {} }`, `cross_tenant: 1`）；存在则只更新 `enabled`；
   - 触发 `notifyInvalidate()`，本实例立即生效；其他 isolate 依赖 60s TTL（文档与产品口径一致）。
2. **一致性与依赖方向**：两次写入不在同一事务，以 **`config` 表为准**：同步失败时 `PUT /config.json` 返回 500（config 已写入），前端提示重试；重试会再次走 upsert，幂等。依赖方向为 `configService → ruleService → ruleManager`，`ruleService` 不得反向依赖 `configService`（避免循环引用）。

**读路径（运行时只认规则，不写库）**：
- `pluginService` 只读取 `ruleService` 中的启用插件规则，不再读 `configService`。
- **去掉读路径自动补齐写库（评审 R3）**。正常部署由 migrate_0035 保证三条系统规则存在；对于「库里缺系统规则」的异常情况（如测试 truncate 清表后），`ruleService` 在加载缓存时若发现某个 `SYS:setting:*` 缺失，只在**内存中合成一条虚拟系统规则**（`id` 取 0、`enabled` 取 `configService` 当前值，默认 `"true"`），参与匹配但不落库、不出现在规则列表。由于虚拟规则 id 为 0，排序上始终排在真实规则之前，与"系统规则先建、id 最小"的常态顺序一致。
  - 依赖方向：合成需要读 config，放在 `pluginService` 侧完成（`pluginService` 本来就可依赖 `configService`），`ruleService` 只暴露"缺失的 biz_id 列表"，不引入 `ruleService → configService` 依赖。

### 3.4 规则缓存与匹配
- **不重构现有 `RuleCache` 的限流/访问控制部分**（评审 R9，避免碰限流热路径）：`RuleCache` 新增一个数组 `pluginRules: SgRule[]`（`type === PLUGIN` 的启用规则），`nonVendorRules` / `vendorRules` 的构建改为排除 `PLUGIN` 类型，保证插件规则不会进入 `checkMatchedRules`。
- 新增 `ruleService.getMatchedPluginRules(scope, ctx)`：从 `pluginRules` 中 `evalExpr(rule.scope, ctx)` 过滤，`ctx = { user_id, model_id, vendor_id }`（插件阶段 vendor 已确定，含 vendor 维度的规则正常匹配）。共享 60s TTL 缓存与 CRUD 即时失效。
- `validateRule` 增加 `RuleType.PLUGIN` 分支（§3.5）。

### 3.5 `pluginConfig` 校验（Operator 决策 3）
前端以 JSON 文本输入，后端在 `createRule` / `updateRule` 中校验：
1. `config` 必须是 plain object；`config.plugin` 为非空字符串且已注册，否则 400 `Unknown plugin: xxx`；
2. `config` 只允许 `plugin`、`pluginConfig` 两个键；
3. `config.pluginConfig` 缺省归一化为 `{}`；必须是 plain object（拒绝数组、`null`、字符串等），序列化后长度 ≤ 4KB；
4. 若插件实现了 `validateConfig`，调用之；插件应拒绝未知键。内置插件规则：
   - `cchRewriter`：仅允许 `cchValue`；类型 string，正则 `^[A-Za-z0-9_-]{1,32}$`（禁止 `;`、空白、换行等会破坏 billing header 结构的字符）；
   - `claudeCodeTrackingRewriter`、`responsesPromptCacheKeyRewriter`：无参数，`pluginConfig` 必须为 `{}`。
5. 错误统一抛 `AppError(400)`，message 写明字段与原因，前端直接展示。

### 3.6 接口与前端
- **路由**：新增 `GET /rule/plugins.json`（`requireAdmin`），返回 `pluginRegistry.list()` 的 `{ name, description, priority, hooks, configExample }[]`。**必须在 `routes.ts` 中注册在 `app.get("/rule/:id")` 之前**，否则会被 `:id` 匹配并返回 `Invalid ID format`；需加路由测试覆盖。
- **列表 `source` 过滤**：`GET /rule/list.json` 新增可选查询参数 `source=user|system`（非法值 400），`ruleManager.listRules` 增加 `where("source", ...)`；不传时返回全部（保持兼容）。
- **前端规则管理**：
  - 页面分「用户规则」（`source=user`）与「系统规则」（`source=system`）两个区域，分别带 `source` 参数请求列表；
  - 用户规则区：新建/编辑弹窗新增 `plugin` 类型：插件下拉（数据来自 `/rule/plugins.json`）+ **JSON 文本框**（placeholder 显示 `configExample`，前端只做 `JSON.parse` 语法预检，业务校验以后端为准）；
  - 系统规则区：只读列表，开关禁用；提示文案按 `tenantScope` 区分主租户/非主租户（见产品文档 §1）；
  - `types/rule.ts`：`RuleType` 增加 `'plugin'`，`Rule` 增加 `source`、`biz_id` 字段。
- **前端高级设置**：tracking 开关字段改为 `claudecode_tracking_rewrite_enabled`。

## 4. 执行模型

### 4.1 排序与执行（Operator 决策 2）

```
规则 scope（管理面）            → 对谁：user_id / model_id / vendor_id（含系统规则、用户规则、内存虚拟系统规则）
  ↓ 命中，展开执行项 {plugin, ruleId, ruleName, bizId, pluginConfig}
插件显式 Hook 方法              → 当前 hook 未实现则跳过
  ↓ 按 (plugin.priority 升序, ruleId 升序) 稳定排序
handler(requestView, context, pluginConfig)
  ↓ 非空补丁
Patch 校验与原子应用            → 拦截根路径/保护字段/保护头，整份应用或整份拒绝
```

- **全部依次执行**：同一插件被多条规则命中（包括系统规则与用户规则同时命中）时，每条规则都执行一次，不做去重、不做"用户规则覆盖系统规则"的特殊处理。
- **排序方向**：先按 `plugin.priority` **从小到大**；同一插件（priority 相同）按 `rule.id` **从小到大**。不同插件 priority 相同时也按 `rule.id` 从小到大。
- **叠加效果**：后一项的 handler 拿到的是**前一项补丁应用后的** body/headers，因此后执行的结果作用在前一次结果之上：
  - `cchRewriter`：系统规则（id 小）先改为 `A1234`，用户规则（id 大）再改为 `B5678` → 上游收到 `B5678`（最后执行的生效）；
  - `responsesPromptCacheKeyRewriter`：第一项已注入 `prompt_cache_key`，后续项检测到已有值直接 `return` → 只注入一次；
  - `claudeCodeTrackingRewriter`：第一项规范化后，后续项正则不再命中 → 无改动、不记录。

### 4.2 每个 hook 的管线

```
1. 取 getMatchedPluginRules(scope, ctx) ∪ 内存虚拟系统规则（仅缺失时，且 enabled）
2. 过滤：plugin 已注册 && 实现了当前 hook 方法（未注册的插件名 → warn activity 一次，跳过）
3. 展开并按 §4.1 排序
4. 逐项执行（每项独立 try/catch）：
   a. patch = handler({ body: bodyObj, headers: headersCopy }, context, pluginConfig)；抛异常 → warn，继续下一项
   b. patch 为空（undefined / 无 op 且无 set/remove）→ 跳过，不记录
   c. 边界检查（任一不通过 → 整份补丁拒绝，warn activity 记录违规路径/头名，继续下一项）：
      - 路径必须是合法 JSON Pointer，且**不能是根路径 ""**（禁止整体替换/删除 body）；
      - 先把路径按 "/" 拆段并做 ~1→"/"、~0→"~" 解码，再**按首段**与 PROTECTED_BODY_ROOTS = {"model","stream","stream_options"} 比较（命中 /model、/model/...，不误伤 /modelx）；
      - headerPatch 的 key 小写后不能落在 PROTECTED_HEADERS（见下）；
   d. 原子应用：在 bodyObj 的深拷贝上依次执行所有 op（RFC 6902 语义；路径不存在、数组下标越界等 → 整份失败、warn），全部成功后再替换 bodyObj、应用 headerPatch；
   e. 应用成功则记入 executed: { plugin, ruleId, ruleName, bizId, patchedPaths, patchedHeaders }
5. executed 非空时写一条 RequestActivityStage.PLUGIN 活动（含 hook、vendor_id、format、executed，§4.4）
```

**PROTECTED_HEADERS**（与 `senderService` 的 `EXCLUDED_HEADERS` 对齐，抽成共享常量，避免插件把已剥离的头加回去）：
`EXCLUDED_HEADERS` 全集（authorization、x-api-key、anthropic-version、content-length、host、origin、referer、connection、keep-alive、proxy-authenticate、proxy-authorization、te、trailer、transfer-encoding、upgrade、cookie、accept、accept-encoding、accept-language、priority、user-agent）∪ `content-type`，以及所有 `cf-`、`sec-` 前缀的头。
- 说明：`anthropic-version` 由网关按客户端声明/默认值写入，不允许插件改；如后续确有插件需要覆盖，再单独评审放开。

### 4.3 只读约定
`PluginRequestView.body` 的 `Readonly` 仅是编译期浅约束。生产环境不做深冻结（32MB 上限的请求体开销不可忽略，内置插件为代码级信任边界）；**单元测试中对 body 深冻结**，保证插件不就地修改。`headers` 传入副本，插件就地修改不影响实际请求。

### 4.4 时间线格式与新旧兼容（评审 R6）
新格式（`detail`）：
```json
{
  "hook": "before_conversion",
  "format": "anthropic",
  "vendor_id": 3,
  "executed": [
    { "plugin": "cchRewriter", "rule_id": 1, "rule_name": "强制改写 CCH", "biz_id": "SYS:setting:cch_rewrite",
      "patched_paths": ["/system/0/text"], "patched_headers": [] }
  ]
}
```
告警（level=warn）`detail`：`{ hook, plugin, rule_id, reason: "handler_error" | "protected_path" | "protected_header" | "root_path" | "apply_failed" | "unknown_plugin", paths?, headers? }`，不含内容原文、不含异常堆栈（只记 `error.message` 截断到 200 字符）。

前端 `ActivityTimeline.vue`：`detail.executed` 存在时按新格式渲染（插件名、规则名、修改路径）；否则按旧格式（`body_len_before/after`）渲染。历史数据不迁移。

### 4.5 failover 与 inspect
- `sendRequestToUpstream` 每次上游尝试都从客户端原始 `body` 重新执行全流程，插件规则按**该次尝试的 vendor_id** 重新匹配，每次尝试各自写 activity。
- inspect（模型路由测试）路径同样执行插件，与现状一致。

## 5. senderService 集成

```
① 构建普通头（EXCLUDED_HEADERS 过滤不变）
② JSON.parse(body) → bodyObj（1 次）：提取 clientModelName，bodyObj.model = vendorModelName（若有）
③ 【before_conversion】pluginService.applyBeforeConversion(bodyObj, headers, ctx)  ← 总是执行
④ 跨协议（needsConversion）：
     converter.updateClientModel / setCredentialSource（顺序不变，仍在转换前）
     bodyObj = converter.convertRequest(bodyObj)   ← 直接调对象版本；convertRequestBody 中的错误包装
                                                    （非 AppError → 400 conversion_error）抽成公共方法复用
     converter.updateModel(bodyObj.model)
     【after_conversion】pluginService.applyAfterConversion(bodyObj, headers, ctx)
⑤ 协议层保底：upstreamFormat === OPENAI && bodyObj.stream === true → stream_options = { include_usage: true }
   （从现状的「转换后插件之前」挪到「之后」；三个内置插件都不涉及该字段，行为等价）
⑥ 写认证头（Authorization / x-api-key）、anthropic-version（API_KEY 模式）、Content-Type
⑦ upstreamBody = JSON.stringify(bodyObj)（1 次）→ streamLog / inspect 快照 / fetch
```

- **②的错误处理**：`llmApiMiddleware.parseLlmRequestBody` 已保证 body 是合法 JSON 对象，此处 parse 失败按 AppError 400 处理（现状是静默跳过替换，属于不可达分支）。
- 认证头在插件之后写入，配合 PROTECTED_HEADERS 前置拦截，双重保证插件不影响鉴权。
- 序列化次数降低是附带收益，**不作为验收项**（评审 §2-6）。

## 6. 内置插件迁移与数据库迁移

### 6.1 三个内置插件改造

| 插件 | priority | 关联 `biz_id` | Hook | 逻辑（返回 `PluginPatchResult | void`） |
|---|---|---|---|---|
| `claudeCodeTrackingRewriter` | 10 | `SYS:setting:claudecode_tracking_rewrite` | before + after | `currentFormat !== ANTHROPIC` 或无 `body.system` → `return`；命中日期标记时 `replace "/system"` 或 `"/system/i/text"` |
| `cchRewriter` | 20 | `SYS:setting:cch_rewrite` | before + after | `currentFormat !== ANTHROPIC` 或无 `body.system` → `return`；首段 `x-anthropic-billing-header:...cch=` 用 `pluginConfig.cchValue ?? "A1234"` 替换 |
| `responsesPromptCacheKeyRewriter` | 30 | `SYS:setting:responses_prompt_cache_key` | before + after | `currentFormat !== RESPONSES` 或已有 `prompt_cache_key` → `return`；否则 `add "/prompt_cache_key"` = `${hostKey}:${clientName}`（空值回落 `local`/`unknown`，与现状一致） |

> 同协议时只跑 `beforeConversion`；跨协议时前后 `currentFormat` 不同，单次尝试中每个内置插件最多在一个钩子命中。替换后值与原值相同时不返回补丁（不记录）。

### 6.2 数据库迁移（`migrate_0035`，sqlite.sql + mysql.sql）
1. 加列与索引：
   ```sql
   ALTER TABLE rule ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'user';
   ALTER TABLE rule ADD COLUMN biz_id VARCHAR(128) NULL DEFAULT NULL;
   CREATE UNIQUE INDEX idx_rule_biz_id ON rule (biz_id);
   ```
2. **tracking 旧 key 合并（Operator 决策 1）**：
   - 背景：前端长期写 `claude_code_tracking_rewrite_enabled`（旧 key），后端只读 `claudecode_tracking_rewrite_enabled`（新 key）；旧 key 仅由界面保存写入，代表管理员在界面上最后一次保存的意图。
   - 规则：**旧 key 行存在 → 以旧 key 值为准**写入新 key（新 key 行存在则 UPDATE，不存在则 INSERT）；旧 key 行不存在 → 新 key 保持不变（不存在时运行期默认 `"true"`）。合并后**删除旧 key 行**。
   - 影响：曾在界面关闭过该开关的部署，升级后 tracking 改写会**真正关闭**（修复行为，需写入 release note）。
3. 插入三条系统规则（`source='system'`，`tenant_id` = main 租户 id（子查询 `SELECT id FROM tenant WHERE name='main'`），`cross_tenant=1`，`scope='{"type":"const","values":[true]}'`，`config='{"plugin":"<name>","pluginConfig":{}}'`，`name` 取映射表默认名称），`enabled` 取第 2 步之后 `config` 表中对应 key 的值：**显式为 `'false'` → 0，否则（含不存在）→ 1**。
   - 说明：`cch_rewrite_enabled` 在 migrate_0017 为存量库预置了 `'false'`，因此老库升级后 CCH 系统规则为禁用；全新库同样会先执行 0017，结果一致。不要按 `CONFIG_DEFAULTS` 的 `"true"` 理解存量行为。
4. 迁移按 id 自增插入，三条系统规则的 id 均大于存量规则；排序只影响同插件多规则（存量库没有 plugin 类型规则），无副作用。

### 6.3 测试初始数据（评审 R5）
- `tests/helpers/dbHelper.truncate` 清空 `rule` 表后**不自动重建系统规则**；运行期由 §3.3 的内存虚拟规则兜底（enabled 跟随 config），保证插件行为与开关一致。
- 需要验证"落库系统规则"的用例显式调用 `PUT /config.json` 或在 setup 中执行 migrate_0035 的 INSERT 片段。
- `tests/api/rule/rule.test.ts` 中 `total` 等条数断言改为带 `source=user` 查询，不受系统规则条数影响。
- `tests/unit/service/pluginService.test.ts`（基于 mock configService）按新管线重写；三个插件现有单测的输入/期望值保留，作为"行为等价"基准。
- 迁移测试覆盖：① 全新库；② 旧库 cch=false、无 tracking 任何 key；③ 旧库存在旧 key=`false`；④ 新旧 key 同时存在且值不同（以旧 key 为准）。
- 所有自动化测试只用本地 sqlite，不连 MySQL 测试库；mysql.sql 做语法层面的人工核对，真库验证留到部署阶段。

## 7. 不做

- 规则 `scope` 不扩 header/body 内容匹配
- 不做规则级 priority 字段、运行时动态上传/卸载脚本、JS 沙箱
- JSON Patch 仅实现 `add` / `replace` / `remove`（不支持 `move` / `copy` / `test`）
- 不做 pluginConfig 字段化表单 / JSON Schema 渲染（Operator 决策 3）
- 不重构限流/访问控制的 `RuleCache` 结构（R9 延后）

## 8. 验收

1. 升级后生成三条带固定 `biz_id` 的系统规则（`source = "system"`，`cross_tenant = 1`，`scope: const true`），`enabled` 与 §6.2 规则一致；旧 tracking key 被合并并删除
2. 三个内置插件的现有单测输入/期望值在新管线下全部保持通过（行为等价基准）
3. 「高级设置 → 请求处理」切换三个开关时，按 `biz_id` 创建/更新系统规则 `enabled`，本实例即时生效；前端提交旧 tracking key 时被映射为新 key
4. 系统规则通过规则接口修改任何字段（含 `enabled`）或删除均返回 403；请求体中的 `source` / `biz_id` 被忽略
5. 用户规则 `source = "user"`、`biz_id = null`，可正常增删改、启停；`GET /rule/list.json?source=user|system` 过滤正确
6. `GET /rule/plugins.json` 正常返回插件列表（不被 `/rule/:id` 拦截）
7. `pluginConfig`：非法 JSON 结构、非对象、未知键、`cchValue` 不合法（如含 `;`、超长）时保存返回 400 并附原因
8. 只声明 `beforeConversion` 的插件在 `after_conversion` 阶段不触发
9. 排序：priority 10/20/30 按序执行；同插件多规则按 `ruleId` 升序全部执行，后者作用于前者结果之上（CCH 系统规则 + 用户规则 → 上游收到用户规则的值）
10. 未修改时不产生 activity；修改时 activity 为新格式；历史旧格式记录在前端正常显示
11. 补丁安全：根路径 `""`、`/model`、`/model/x`、`/stream`、`/stream_options`、`~1` 转义绕过、PROTECTED_HEADERS（含 `cf-*`/`sec-*`）均被整份拒绝并记 warn；`/modelx` 不被误拦；同一补丁中一条违规时其余 op 也不生效
12. 插件 handler 抛异常时请求照常发出，记 warn
13. 跨协议场景 `applyBeforeConversion` 与 `applyAfterConversion` 各调用一次，同协议只调用前者；failover 时每次尝试按该次 vendor 重新匹配
14. 库中缺少系统规则时（truncate 后），插件行为跟随 config 开关，且不产生任何 rule 表写入
