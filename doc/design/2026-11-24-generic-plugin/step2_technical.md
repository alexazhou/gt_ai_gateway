# 通用插件机制技术设计

## 1. 核心思路

将硬编码在 `pluginService` 中的三个请求改写器升级为规则驱动的通用插件机制，职责拆分为三层：

- **规则层（触发与顺序）**：复用 `rule` 表的 `scope` 条件树决定对谁生效；新增 `priority`（`0 ~ 10000`，默认 `100`，越小越先执行）控制顺序，新增 `source`（`system` / `user`）与 `biz_id` 区分系统联动规则与用户自定义规则。
- **插件层（改写逻辑）**：内置插件自注册到 `pluginRegistry`，**自身不设优先级**；按需实现转换前/转换后钩子，接收只读请求视图与规则参数，返回声明式补丁（`bodyPatch` + `headerPatch`）。
- **管线层（安全与留痕）**：在 `senderService` 选定上游后，按命中规则的 `(priority, id)` 升序依次执行（不去重，后执行的在前序结果上叠加）；统一拦截受保护的字段和请求头，异常仅记告警不阻断转发。

## 2. 插件接口

```ts
export type PluginHook = "before_conversion" | "after_conversion";

export type JsonPatchOp =
    | { op: "add"; path: string; value: unknown }
    | { op: "replace"; path: string; value: unknown }
    | { op: "remove"; path: string };

export interface HeaderPatch {
    set?: Record<string, string>;
    remove?: string[];
}

export interface PluginPatchResult {
    bodyPatch?: JsonPatchOp[];
    headerPatch?: HeaderPatch;
}

export interface PluginContext {
    readonly hook: PluginHook;
    readonly clientModel: string;
    readonly clientFormat: ApiFormat;
    readonly upstreamFormat: ApiFormat;
    readonly currentFormat: ApiFormat;
    readonly hostKey: string;
    readonly clientName: string | null | undefined;
}

export type PluginHookHandler = (
    request: { readonly body: Readonly<Record<string, unknown>>; readonly headers: Headers },
    context: PluginContext,
    pluginConfig: Record<string, unknown>,
) => PluginPatchResult | void;

export interface RequestPlugin {
    readonly name: string;
    readonly description?: string;
    readonly configExample?: Record<string, unknown>;
    readonly beforeConversion?: PluginHookHandler;
    readonly afterConversion?: PluginHookHandler;
    validateConfig?(pluginConfig: Record<string, unknown>): void;
}
```

- **按需实现钩子**：同协议请求仅触发 `beforeConversion`；跨协议请求在协议转换前后分别触发 `beforeConversion` 与 `afterConversion`。插件内部根据 `currentFormat` 与请求体判断是否需要处理，无需修改直接 `return`。
- **参数校验**：规则保存时调用插件的 `validateConfig` 校验 `pluginConfig`，不合法直接返回 `400`。

## 3. 规则模型与高级设置联动

### 3.1 表结构扩展（`migrate_0035`）

`RuleType` 新增 `PLUGIN = "plugin"`，`rule` 表新增三列：

| 字段 | 类型 | 说明 |
|---|---|---|
| `priority` | `INT NOT NULL DEFAULT 100` | 执行优先级（`0 ~ 10000` 整数，越小越先执行） |
| `source` | `VARCHAR(32) NOT NULL DEFAULT 'user'` | 规则来源：`system`（系统规则）/ `user`（用户规则） |
| `biz_id` | `VARCHAR(128) NULL UNIQUE` | 系统规则业务标识（如 `SYS:setting:cch_rewrite`），用户规则为 `null` |

`type = "plugin"` 时，`rule.config` 结构为 `{ plugin: string, pluginConfig: Record<string, unknown> }`。

### 3.2 系统规则与高级设置同步

「高级设置 → 请求处理」保留三个开关，与 `main` 租户下的全局共享系统规则（`cross_tenant = 1, scope = const true`）一一对应：

| 配置项（`ConfigKey`） | 系统规则 `biz_id` | 插件名 | 预置 `priority` |
|---|---|---|---|
| `claudecode_tracking_rewrite_enabled` | `SYS:setting:claudecode_tracking_rewrite` | `claudeCodeTrackingRewriter` | `10` |
| `cch_rewrite_enabled` | `SYS:setting:cch_rewrite` | `cchRewriter` | `20` |
| `responses_prompt_cache_key_enabled` | `SYS:setting:responses_prompt_cache_key` | `responsesPromptCacheKeyRewriter` | `30` |

- **迁移初始化**：`migrate_0035` 统一旧前端遗留的 `claude_code_tracking_rewrite_enabled` 键名到 `claudecode_tracking_rewrite_enabled`（以旧键保存值为准），并按当前配置生成上述三条系统规则。
- **写联动，读归口**：修改高级设置开关时按 `biz_id` 同步更新系统规则的 `enabled` 并失效规则缓存；请求运行期只从 `ruleService` 读取规则，不再直接读 `configService`。
- **只读保护**：`source = "system"` 的规则禁止通过规则接口修改或删除（统一返回 `403`）；创建/更新用户规则时忽略请求体传入的 `source` 与 `biz_id`。

### 3.3 规则排序与匹配

- 启用规则缓存与规则管理列表统一按 **`(priority ASC, id ASC)`** 排序。
- `RuleCache` 新增 `pluginRules` 列表；访问控制与频率限制维持原有的「路由前/路由后两阶段分流」及「访问控制先于限流」不变，同阶段同类型内按优先级顺序检查。

## 4. 转发链路集成与安全边界

在 `senderService` 每次选定上游供应商后执行（failover 切换供应商时按新 `vendor_id` 重新匹配）：

```text
构建基础请求头 → 解析请求体并替换上游模型名
  → 匹配本次上游命中的插件规则（按 priority ASC, id ASC）
  → 执行 beforeConversion
  → [跨协议时] 协议转换 → 执行 afterConversion
  → 注入 stream_options 与上游鉴权头 / Content-Type → 发送请求
```

- **安全边界**：禁止补丁替换根对象、禁止修改核心计费/路由字段（`model` / `stream` / `stream_options`）、禁止修改鉴权头及网关已剥离的管控头；鉴权头在插件之后写入作为双重保障。单次补丁若有违规或路径非法则整份拒绝。
- **异常容错**：插件执行抛错或补丁被拒时记录一条 `warn` 级别时间线，不影响原请求继续发出。
- **时间线留痕**：仅当补丁实际生效时写入一条 `plugin` 阶段时间线（`details.executed` 记录插件名、规则名、优先级与变更路径，不记录原文）；前端 `ActivityTimeline` 兼容新旧两种格式展示。

### 内置插件迁移对照

| 插件 | 生效协议 | 改写行为 | `pluginConfig` 校验 |
|---|---|---|---|
| `claudeCodeTrackingRewriter` | `anthropic` | 规范化 `system` 中的 `# currentDate` 日期标记 | 必须为空对象 `{}` |
| `cchRewriter` | `anthropic` | 将 `system` 首段 billing header 中的 `cch=` 替换为 `cchValue`（默认 `A1234`） | 仅允许 `cchValue`（1~32 位字母数字下划线短横线） |
| `responsesPromptCacheKeyRewriter` | `responses` | 未携带 `prompt_cache_key` 时注入 `${hostKey}:${clientName}` | 必须为空对象 `{}` |

## 5. 接口、前端与 CLI

- **后端接口**：
  - 新增 `GET /rule/plugins.json`：返回已注册插件列表（`name`、`description`、`hooks`、`configExample`），注册在 `/rule/:id` 之前。
  - 扩展 `GET /rule/list.json`：支持 `?source=user|system` 筛选。
  - 扩展规则创建/更新校验：校验 `priority`（`0 ~ 10000` 整数）与 `plugin` 类型的 `config`，兼容局部字段更新。
- **前端**：
  - 规则管理页拆分为「用户规则」与「系统规则」两区，表格增加「优先级」列；
  - 新建/编辑规则弹窗增加优先级输入，新增「请求插件」类型（插件下拉 + JSON 参数输入框）；
  - 高级设置页修正 tracking 开关字段名；请求详情时间线适配新插件日志格式。
- **CLI**：`gtgw rule` 补充 `plugins` 子命令与 `list --source` 参数，同步更新 `route-map.json`。
