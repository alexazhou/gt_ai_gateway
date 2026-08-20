# V1.7: 客户端配置管理与插件 - 技术文档

## 架构概览

V1.7 增加两块能力：**客户端配置管理**（读写本机客户端配置文件）与**请求改写插件**（转发前改写请求体）。两者相互独立。

## 客户端配置管理

### 模块结构

```text
clientConfigService/
├── core.ts                 # 业务编排：备份/启用/同步/应用
├── types.ts                # 类型定义（ClientConfigContent 等）
├── configAdapterUtils.ts   # 状态构建、网关用户查询
├── baseConfigAdapter.ts    # 适配器基类 + DI 注入
├── claudeCodeConfigAdapter.ts
├── codexConfigAdapter.ts
└── configAdapterUtils.ts
```

### 核心设计

- **ConfigAdapter 接口**：`readConfig / writeConfig / parseConfigFileContent / patchConfigFileContent / verifyClientConfigContent`，每个客户端一个适配器
- **配置存储**：备份记录存 `client_config` 表（`configContent` JSON，含 version / connectionMode / gatewayUrl / apiKey / model / effortLevel / authJson），本地文件只读当前状态
- **apply 语义**：应用备份时对本地文件做 **patch**（合并到现有文件），保留用户手动添加的 `mcpServers` 等段，避免整体覆盖丢失数据
- **连接模式**：GATEWAY / VENDOR / OFFICIAL 三种模式由后端 `ConnectionMode` 枚举定义；OFFICIAL 跳过网关校验、保留用户自带 Key
- **供应商匹配**：`vendorService.findVendorByUrl` 按 URL 前缀匹配供应商 ID（前端不再反查）
- **TOML 解析**：用 smol-toml 库替换手写解析

## 请求改写插件

### 设计（静态内置插件，非脚本化）

```text
pluginService.applyRequestPlugins(body, format, hostKey, clientName)
  ├── ANTHROPIC：claudeCodeTrackingRewriter（移除追踪标记）
  │              cchRewriter（CCH 改写）
  └── RESPONSES：responsesPromptCacheKeyRewriter（注入 prompt cache key）
```

- 插件为内置代码模块（`src/plugin/`），通过 config 开关（`CCH_REWRITE_ENABLED`、`RESPONSES_PROMPT_CACHE_KEY_ENABLED`、`CLAUDE_CODE_TRACKING_REWRITE_ENABLED`）启用 / 禁用
- 改写发生在协议转换后的最终请求体上，对上游格式生效

## 附录：早期脚本插件设计（未采用）

V1.7 前的插件产品规划曾设想「用户可配置 JS 脚本插件」的形态，最终因复杂度过高未落地，实际采用**编译期内置 + 配置开关**的轻量方案。保留该设计记录如下，供后续扩展参考：

- **概念**：插件为独立的改写规则，绑定在模型上，多个插件按 `order` 顺序依次执行；插件输入当前请求体，输出一个 **patch**（JSON Merge Patch，RFC 7396：有值覆盖、`null` 删除、未出现保留）
- **脚本签名**：`function modify(body) { return patch }`，如 `return { max_tokens: 4096 }`、`return { system: prefix + (body.system || "") }`
- **设想的数据表 `plugin`**：id / model_id / name / script（TEXT）/ enabled / order
- **设想的 API**：`/plugin/list.json?model_id=`、create / update / toggle / delete
- **设计约束**：只能改请求体、脚本沙箱运行（无网络 / 文件 / 全局状态）、执行超时 100ms、出错跳过不中断请求

## 其他

- `hostService` 生成并缓存 host key，作为客户端身份标识
- 数据库 schema 校验在初始化 / 迁移后自动执行
- LLM 错误响应统一为标准 JSON 结构

## 相关文档

- [产品文档](./step1_product.md)
- 专项设计：[client_manager_design.md](./client_manager_design.md)、[connection_mode_official_design.md](./connection_mode_official_design.md)
