# new-api 插件机制分析（参考实现）

来源：`https://github.com/QuantumNous/new-api`，commit `6627f0e`（2026-11-24，shallow clone 于 `/Volumes/PData/GitDB/new-api`）。
用途：gt_ai_gateway 通用插件机制设计的对照参考，不构成上线依赖。

## 1. 总体架构

两套插件体系**共用同一 JS 宿主运行时**，插件均为运行时加载的**单文件同步 ECMAScript 模块**：

```
plugins/tasks/<key>/plugin.js
    │  jsplugin.DefaultRegistry.RegisterFactory(source, Options{Key})
    ▼
pkg/jsplugin（宿主运行时：编译校验 / 沙箱 / 超时 / 并发 / 内存 / utils）
    │
    ├── 任务插件（渠道适配器）：channel 选择 → buildSubmitRequest → HTTP → parse*；
    │                        重试 / 轮询 / 持久化 / 计费结算全部在 Go 侧
    └── 请求插件（请求处理链）：ingress → request → outbound → egress → reply/report
```

- 内置插件通过 `plugins/embed.go` 的 `go:embed tasks` 在 `init()` 中按目录注册（`RegisterFactory`）。
- 管理员可上传 / 覆盖插件版本（root 权限，`POST /api/plugin/task`），registry **按 generation 原子发布**；单个请求生命周期内锁定一个插件版本，后台轮询可切换到更新的活动版本。
- 两套插件共用 `meta.apiVersion = 1` 契约与同一份 `configSchema`（JSON Schema）校验。

## 2. 宿主运行时 `pkg/jsplugin`

| 项 | 实现 |
|---|---|
| JS 引擎 | `MoeForge/moejs`（`pkg/jsplugin/engine.go`），同步执行 |
| 单次调用超时 | 默认 5s（`DefaultCallTimeout`） |
| 并发上限 | 默认 8（`DefaultConcurrency`） |
| 内存上限 | `PLUGIN_MEMORY_LIMIT_MB`，每次 hook 调用独立预算 |
| 沙箱禁止 | 全局 `fetch`、文件系统、`require`、`import`、async 函数、`eval` / `new Function`、环境变量 |
| 受限网络 | `utils.fetch` 仅 GET / HEAD / POST，限 request descriptor 允许的 host，SSRF 检查初始 URL 与每次重定向 |
| 输入限制 | 请求体 / 响应体大小上限、`MAX_FILE_DOWNLOAD_MB` 约束产物下载 |
| 治理工具 | `new-api plugin lint`、`new-api plugin test --fixture`、沙箱 dry-run（`POST /api/plugin/task/:key/dryrun`） |

## 3. 插件契约

### 3.1 任务插件（渠道适配器）

| 导出 | 说明 |
|---|---|
| `meta` | `key` / 本地化 `name` / `description` / `version` / `author` / `configSchema` / `routes` / `protocols` / `scope` / `optional` / `allowedHosts` |
| `buildSubmitRequest(ctx)` | 构造提交上游的请求描述 |
| `parseSubmitResponse(ctx, resp)` | 解析提交响应 |
| `parseTaskResult(ctx, body)` | 解析查询结果 |
| `buildQueryRequest(ctx)` | `per_task` 模式的轮询请求 |
| `buildBatchQueryRequest` / `parseBatchResult` | `batch` 模式的批量轮询 |
| `extractUsage` / `extractUsageOnSubmit` / `extractUsageOnComplete` | 上报用量**事实**（秒数、分辨率、上游 units），绝不计算价格 |
| `listArtifacts(task)` + `buildContentRequest(ctx)` | 产物列表与内容代理（host 签名 capability URL，非供应商 URL） |
| `protocols` / `native` | 协议绑定：声明 vendor 原生路由与编解码器 |

### 3.2 请求插件（请求处理链）

阶段与允许返回的 effect 类型白名单（`relay/requestplugin/plan.go:29-41`）：

| 阶段 | 时机 | 允许 effects |
|---|---|---|
| `ingress` | 客户端请求进入网关、路由前（另有 late `ingress`） | `json.patch`、`media.text`；不允许改 `model` / `stream`（guard 测试覆盖） |
| `request` | 推理参数处理 | `reasoning.set` |
| `outbound` | 协议转换后、发往上游前 | `json.patch`、`header.patch`、`media.reencode`、`media.text` |
| `egress` | 上游请求发出前最后一道（param override 之后） | **只读**（finding / report） |
| `reply` | 上游回复改写 | 按插件能力，如脱敏、拒绝 |
| `report` | 请求完成上报 | 观察 |

返回结构为**声明式效应**，不直接操作请求对象：

```js
{
  action: "continue" | "reject",
  effects: [
    { type: "json.patch",   ops: [/* RFC 6902 JSON Patch */] },
    { type: "header.patch", set: { "X-Request-Source": "new-api" }, remove: ["X-Unwanted"] },
  ],
}
```

`reject` 可以带 `code` 与截断到 256 字符的 `message`。

## 4. 协议转换与插件的先后

主流程 `relay/compatible_handler.go:104-155`：

```
① requestplugin.Ingress        （controller/relay.go:139）  body = 客户端格式
② adaptor.ConvertOpenAIRequest + service.ConvertRequest → relayconvert
③ common.Marshal(convertedRequest) → jsonData               body = 上游格式
④ requestplugin.Outbound(c, info, jsonData)                 可 json.patch / header.patch
⑤ relaycommon.ApplyParamOverrideWithRelayInfo               渠道 param override
⑥ requestplugin.Egress(c, info, jsonData)                   只读
⑦ adaptor.DoRequest(...)                                    发上游
```

文档依据：`ctx.format` 在 `ingress` / `request` 是客户端 body，在 `outbound` / `egress` / late `ingress` 是上游 body（`docs/plugin-api/v1.md:1103`）。

特例：

- **Pass-Through 渠道**（`passThroughGlobal` 或 `PassThroughBodyEnabled`）：跳过转换，`requestplugin.PassThrough` 直接处理原始 body。
- **late ingress**：`relay/requestplugin/relay.go:142` 标记 `Late, Unpriced`，在转换后以 `ingress` 阶段运行（Realtime 等需要上游格式视图的场景）。
- **任务链路**：`relay/relay_task.go:208,376` 的 `TaskAttempt` / `TaskEgress`，协议转换在任务适配器内部按 `native` 协议进行。

## 5. 激活与作用域模型（请求插件）

配置项 `request_plugin_setting.instances`（`setting/request_plugin_setting/config.go`），一条实例 = 一次启用：

```json
{
  "id": "...", "name": "...", "plugin": "param-override",
  "enabled": true, "global": false,
  "groups": ["vip"], "models": ["gpt-4o*"],
  "config": { "...": "按插件 configSchema 校验" },
  "plugin_scope": { "models": [], "channel_types": [] }
}
```

| 字段 | 语义 |
|---|---|
| `global` | 对全部请求生效 |
| `groups` | 对指定用户分组生效 |
| `models` | 收窄到指定模型（空 = 全部） |
| 渠道绑定 | 渠道的 `request_plugins` 设置列出要运行的实例 |
| `config` | 保存时按插件 `configSchema` 校验并落默认值 |
| `plugin_scope` | 插件自声明范围（models + channel_types），管理员确认后自动覆盖新增渠道/模型 |
| `meta.optional` | 插件失败是否阻断请求（旧 `required` 字段已废弃） |

实例列表整体替换（`instancesMu` 读写锁），单次请求读到一份一致快照。

## 6. 安全与不可变边界

| 边界 | 实现 |
|---|---|
| 认证头保护 | `IsRequestPluginProtectedHeader`：`requestpatch` 保护列表 + `x-api-key` / `api-key` / `x-goog-api-key`，`header.patch` 不可改 |
| 计费字段锁 | `SameBillingFields`：`model` / `stream` / `stream_options` / `n` / `generationConfig.candidateCount` / `size` / `quality` / `resolution` / `seconds` / `duration` / `service_tier` 改动直接拒绝 |
| 阶段效应白名单 | `stageEffects`：未声明阶段返回多余 effect 即 `invalid_effect` |
| 计费职责 | 插件只报 usage facts；定价、换算上下限、结算、退款全在宿主 |
| 审计双轨 | `RequestPluginStep`（管理员审计：实例/阶段/effects 数/耗时/错误类，**不含内容**）+ `RequestPluginRecord`（日志公开记录：上限 32 条 / 8 KB，仅记变更路径与计数，不存旧值、匹配文本、header 值、规则 id、异常文本） |
| 上传信任 | 上传插件 = 管理员级信任决策，等同配置供应商凭据；非硬内存隔离边界 |

## 7. 内置插件清单（17 个，`plugins/tasks/`）

任务/渠道适配器（11）：`sora`、`kling`、`doubao`、`alibaba`、`google`、`jimeng`、`hailuo`、`vidu`、`vertex-ai`、`xai`、`sunoapi`

请求处理（6）：

| 插件 | 钩子 |
|---|---|
| `param-override` | `outbound` |
| `image-compress` | `outbound` |
| `auto-reasoning` | `request` |
| `content-moderation` | `ingress` + `reply` |
| `request-filter` | `ingress` + `egress` + `reply` |
| `request-redact` | `ingress` + `egress` + `reply` |

## 8. 与 gt_ai_gateway 插件设计的对照

> 已按 step2_technical 修订 v2 同步（2026-11-24）。

| 维度 | new-api | gt_ai_gateway（本目录 step2_technical） |
|---|---|---|
| 插件形态 | 运行时上传的沙箱 JS，可版本回滚 | 编译期 TS 代码模块，自注册 |
| 改写方式 | 声明式 effects（json.patch / header.patch） | 声明式 `jsonPatch`（add/replace/remove）+ `headerPatch`，以插件执行项为单位原子应用 |
| 阶段 | 钩子名与转换位置硬绑定（ingress/outbound/...） | 两个显式 hook 方法 `beforeConversion` / `afterConversion`，方法内按 `context.currentFormat` 自判 |
| 激活 | 实例配置（global/groups/models/channel 绑定） | 规则 `scope`（user_id/model_id/vendor_id）+ `enabled`；系统规则（`source=system`）与高级设置联动 |
| 保护 | 阶段效应白名单 + 认证头/计费字段直接拒绝 | 前置拒绝：禁根路径、按首段锁 `model`/`stream`/`stream_options`、保护头对齐 `EXCLUDED_HEADERS`；认证头在插件后写入 |
| 审计 | 专门记录类型，只记计数与路径，强制截断 | activity 只记插件/规则/修改路径/Header key，不记内容 |
| 信任模型 | 插件 = 管理员级信任，非硬隔离 | 代码即信任边界，无沙箱需求 |

可借鉴点（按价值排序）：

1. **声明式 effects**：json.patch / header.patch 让改动可审计、可拒绝、可比较；比"直接改可变对象"更安全。
2. **阶段 × 效应白名单**：`egress` 只读、`ingress` 禁改 model、`outbound` 禁改计费字段，前置拒绝而非事后恢复。
3. **审计只记计数不记内容**：32 条 / 8 KB 硬上限，避免日志泄漏请求内容。
4. **实例化配置 + 插件自声明 scope**：与规则 scope 思路同构，可参考其"管理员确认 scope"机制。
5. **configSchema 在保存时校验**：已采纳为「JSON 文本输入 + 后端格式校验 + 插件 `validateConfig`」，不做 JSON Schema 表单渲染（Operator 决策）。

不适用部分：沙箱运行时、插件上传/版本回滚、多租户插件市场依赖其"插件即配置"的产品定位，gt_ai_gateway 如果维持"代码即插件"则无需引入。

## 9. 关键源码索引

| 主题 | 路径 |
|---|---|
| 宿主运行时 | `pkg/jsplugin/`（engine.go、registry.go、transform.go、request.go、fetch.go） |
| 插件注册与内嵌 | `plugins/embed.go` |
| 请求插件阶段管线 | `relay/requestplugin/`（plan.go、relay.go、record.go、reply.go） |
| 请求插件记录类型 | `relay/common/request_plugin.go` |
| 激活配置 | `setting/request_plugin_setting/config.go` |
| 管理 API | `controller/request_plugin.go`、`controller/task_plugin.go` |
| 主流程调用点 | `relay/compatible_handler.go`、`controller/relay.go`、`relay/relay_task.go` |
| 契约文档 | `docs/plugin-api/README.md`、`v1.md`、`v1.d.ts`、`v1.schema.json` |
| 内置插件 | `plugins/tasks/<key>/plugin.js` |
