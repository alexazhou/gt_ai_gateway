# 命令行工具（CLI） - 技术文档

## 架构概览

CLI 工具 `gtgw` 作为独立 Go Module 放在仓库 `cli/` 目录下，通过标准 HTTP/HTTPS 与网关 REST API 通信，编译为**零外部运行时依赖（`CGO_ENABLED=0`）的单文件原生二进制**。

```text
用户终端 / CI 脚本
  │
  ▼
gtgw (Go Binary)
  ├── cmd/             Cobra 命令树、Flag 绑定、参数校验
  ├── internal/config/ 配置优先级合并、Profile 读写 (0600)、Tauri 配置探测
  ├── internal/client/ 统一 HTTP 客户端 (Bearer / X-Tenant-ID)、SSE 流式解析
  ├── internal/output/ Table / JSON / Quiet 渲染、进度条、Token 脱敏
  └── internal/prompt/ 危险操作二次确认 (--yes)、密文输入
  │
  ▼ HTTPS / HTTP (REST JSON + SSE)
Serverless AI Gateway (Node / Docker / Cloudflare Workers)
```

### 技术选型

| 组件 | 选型 | 理由 |
| :--- | :--- | :--- |
| 语言与版本 | Go 1.22+ | 编译为单文件原生二进制，无 Node.js 依赖，交叉编译简单 |
| 命令框架 | `github.com/spf13/cobra` | 成熟的子命令树、自动 Help、Flag 绑定与 Shell 补全生成 |
| HTTP / SSE | Go 标准库 `net/http` + `bufio.Scanner` | 零额外网络库依赖，流式控制精确 |
| 表格渲染 | 轻量 `text/tabwriter`（标准库） | 无需复杂 TUI 依赖，对齐输出且体积小 |
| 终端交互 | `golang.org/x/term`（密文输入与 TTY 检测） | 跨平台隐藏 Token 输入回显 |

---

## 目录结构

```text
cli/
├── go.mod
├── go.sum
├── main.go                          # 入口：注入 version/commit，执行 cmd.Execute()
├── cmd/
│   ├── root.go                      # 全局 Flags (--url/--token/--tenant/--profile/--json/-q/-y)
│   ├── auth.go                      # login / logout / status / profile (list|use|remove)
│   ├── update.go                    # update check
│   ├── dashboard.go                 # dashboard
│   ├── config.go                    # config get / set
│   ├── vendor.go                    # vendor & vendor model 子命令
│   ├── model.go                     # model 子命令 (含 route-test)
│   ├── user.go                      # user 子命令 (含 recharge)
│   ├── balance.go                   # balance list / get
│   ├── tenant.go                    # tenant 子命令
│   ├── rule.go                      # rule 子命令
│   ├── record.go                    # record 子命令 (含 watch / clear-orphans / activity)
│   ├── client_config.go             # client & client backup 子命令
│   ├── test_llm.go                  # test chat / messages / responses / models
│   └── integration.go               # integration env
└── internal/
    ├── config/
    │   ├── config.go                # Profile 结构体、0600/0700 原子写入、优先级合并
    │   ├── config_test.go
    │   ├── tauri.go                 # 跨平台 Tauri config.json 探测与地址规范化
    │   └── tauri_test.go
    ├── client/
    │   ├── client.go                # 请求封装、Bearer/X-Tenant-ID 注入、错误码映射
    │   ├── sse.go                   # OpenAI / Anthropic / Responses SSE 增量解析
    │   └── sse_test.go
    ├── output/
    │   └── output.go                # JSON / Quiet / Table 输出、Token 脱敏、进度条
    └── prompt/
        └── prompt.go                # TTY 检测、--yes 确认、隐藏 Token 输入
```

---

## 核心模块设计

### 1. 配置解析与 Tauri 桌面端联动（`internal/config`）

#### 配置文件路径与结构
- **全平台统一**：家目录下的 `.gtgw/config.json`
  - macOS / Linux：`~/.gtgw/config.json`
  - Windows：`%USERPROFILE%\.gtgw\config.json`（**不落 `%APPDATA%`**）
- **旧路径不再读取**：`${XDG_CONFIG_HOME:-~/.config}/gtgw/config.json` 已废弃，不做双读、不做静默迁移；`XDG_CONFIG_HOME` 不再参与配置目录推导。

```json
{
  "active_profile": "local",
  "profiles": {
    "local": {
      "base_url": "http://127.0.0.1:8720",
      "token": "sk-...",
      "default_tenant": "main"
    },
    "tauri": {
      "base_url": "http://127.0.0.1:6722",
      "token": "sk-...",
      "from_desktop": true
    }
  }
}
```

`from_desktop` 是「这条 Profile 的地址与 Token 来自本机桌面端」的持久标记：只由 `gtgw login --from-tauri` 写入，其它登录方式对同名 Profile 会显式清零。破坏性闸门只认这个标记，**不认 Profile 名字**（用户可用 `--profile foo` 改名）。

#### 安全写入与权限控制
- 目录不存在时以 `0700` 创建（POSIX）。
- 写入时先写同目录临时文件（`0600`），再 `os.Rename` 原子替换，防止并发或异常中断损坏配置。
- Token 展示统一使用脱敏函数：长度 `<= 8` 显示 `****`，否则保留前 4 位与后 4 位（如 `sk-a****f9e2`）。

#### 配置解析优先级
按以下顺序合并 `BaseURL`、`Token`、`Tenant`（高优先级覆盖低优先级）：

1. **命令行参数**：`--url`、`--token`、`--tenant`
2. **环境变量**：`GTGW_URL`、`GTGW_TOKEN`、`GTGW_TENANT`
3. **指定或当前激活 Profile**：`--profile <name>` 或 `config.json` 中的 `active_profile`

**没有第 4 层**：隐式的「Tauri 桌面端自动回退」已整层删除（`config.Resolve()` 不再产生 `SourceTauri`）。
三层都为空时解析结果是空地址，由调用方统一报「没有可用的网关地址：请先 `gtgw login`，或传 --url / 设置 GTGW_URL」，
绝不自动连任何地址。本机桌面端只作为一种**显式 Profile** 存在（`gtgw login --from-tauri`）。

#### 破坏性命令闸门（`cli/cmd/safety.go`）
- 判据：当前生效 Profile 带 `from_desktop` 标记，**且**生效的 `base_url` 就来自该 Profile（若用 `--url` / `GTGW_URL` 覆盖了目标地址则不拦，因为实际操作的不是那个网关）。
- 命中且未传 `--allow-local-destructive`：退出码 `2`、**零请求**，`-y` 不放行；报错打印 Profile 名与目标地址。
- 命中且已显式放行：放行，并把 Profile 名与目标地址打到 stderr，让用户看清连的是哪。
- 其它来源不干预。

#### Tauri 配置探测规则（`tauri.go`）
对应 `tauri/src-tauri/src/lib.rs` 的持久化路径：
- **macOS**：`~/Library/Application Support/GtCoder/AiGateway/config.json`
- **Windows**：`%APPDATA%\GtCoder\AiGateway\config.json`
- **Linux**：`${XDG_DATA_HOME:-~/.local/share}/GtCoder/AiGateway/config.json`

读取字段 `host`、`port`、`root_token`：

- **`host` 的规范化（CLI 侧实现，三例）**：`""`、`0.0.0.0`、`::` 一律映射为 `127.0.0.1`。
  这里的依据要写清，因为桌面端代码本身只覆盖了其中一种：
  - `0.0.0.0` → `127.0.0.1`：与桌面端 `tauri/src-tauri/src/utils.rs:7-13` 的 `generate_client_url` 一致（它只有 `host == "0.0.0.0"` 这一个分支）。
  - `""` → `127.0.0.1`：桌面端 `tauri/src-tauri/src/lib.rs:530-534` 的 `read_config` 在读到空 `host` 时不会采用，落回 `DEFAULT_HOST`（`lib.rs:103`，值为 `127.0.0.1`）。即**正常写盘路径上不会出现空 host**；CLI 仍显式处理空值，是为了不依赖「上游一定先兜过」这个前提（手改配置、旧版本配置、他方写入都可能留空）。
  - `::` → `127.0.0.1`：桌面端代码未做映射（`utils.rs` 只判 `0.0.0.0`），但 `::` 是合法的 IPv6 通配监听地址，直连会拼出 `http://::6722`（非法 URL）。CLI 这里是对桌面端行为的**超集**：容忍 `::` 并映射回环。
- **`port` 缺省值**：配置里没有 `port`（或越界）时按 `6722` 处理，依据是桌面端 `tauri/src-tauri/src/lib.rs:102` 的 `DEFAULT_PORT = 6722`；否则会拼出 `http://127.0.0.1:0`。
- 拼装 `base_url = fmt.Sprintf("http://%s:%d", clientHost, port)`。
- `gtgw login --from-tauri` 会显式读取该配置并调用 `GET /status.json` 验证后保存为 Profile（默认名 `tauri`）。

---

### 2. 统一 HTTP 客户端与错误处理（`internal/client`）

#### 请求头与超时
- 管理端请求默认携带：
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
  - 若解析出有效 `Tenant`，携带 `X-Tenant-ID: <tenant>`
- 普通管理接口默认超时 `30s`；`vendor test`、`model route-test`、`test chat|messages|responses` 等推理/测试请求使用更长超时（默认 `120s`，支持 `--timeout` 覆盖），SSE 流式请求不设整体读取超时（依赖服务端结束或 `Ctrl+C` Context 取消）。

#### 错误分类与退出码约定

| 退出码 | 含义 | 触发条件 |
| :---: | :--- | :--- |
| `0` | 成功 | 请求与命令执行成功 |
| `1` | 业务 / 服务端错误 | HTTP 400 / 404 / 409 / 422 / 5xx，或网络连接失败 |
| `2` | 参数错误 | 缺失必填参数、JSON 文件解析失败、Flag 非法 |
| `3` | 鉴权 / 权限错误 | 本地无有效 Token，或服务端返回 HTTP 401 / 403 |

错误响应体统一尝试解析后端格式 `{ "error": "...", "message": "...", "code": "...", "request_id": "..." }` 并输出至 `stderr`；若启用 `--json`，错误信息可按结构化 JSON 输出到 `stderr`，确保 `stdout` 保持干净。

---

### 3. 全量命令与后端 API 映射

所有接口路径与 [src/routes.ts](file:///Volumes/PDATA/GitDB/serverless_ai_gateway/src/routes.ts) 严格对齐；创建/更新类命令均支持 `--file <path>`（传 `-` 从 `stdin` 读取 JSON）或常用快捷 Flags。

#### 3.1 会话与系统
- `gtgw login [--url ...] [--token ...] [--profile <name>] [--from-tauri]` → `GET /status.json`
- `gtgw logout` → 清除当前激活 Profile 的 Token
- `gtgw profile list | use <name> | remove <name>` → 本地 Profile 管理
- `gtgw status` → `GET /status.json`
- `gtgw update check` → `GET /update.json`
- `gtgw dashboard` → 并发请求 `GET /stats/dashboard.json` 与 `GET /stats/recent.json`
- `gtgw config get` → `GET /config.json`
- `gtgw config set [--file ... | --key value ...]` → `PUT /config.json`（仅 `main` 视角）

#### 3.2 供应商与模型
- `gtgw vendor presets` → `GET /vendor/preset-urls.json`
- `gtgw vendor list` → `GET /vendor/list.json`
- `gtgw vendor get <id>` → `GET /vendor/:id`
- `gtgw vendor create --file <json>` → `POST /vendor/create.json`
- `gtgw vendor update <id> --file <json>` → `PUT /vendor/:id`
- `gtgw vendor delete <id> [-y]` → `DELETE /vendor/:id`
- `gtgw vendor test <id> [--format openai|anthropic|responses] [--model ...] [--content-mode text|image]` → `POST /vendor/:id/test.json`
- `gtgw vendor model list <vendorId>` → `GET /vendor/:id/model/list.json`
- `gtgw vendor model fetch <vendorId>` → `GET /vendor/:id/model/fetch.json`
- `gtgw vendor model sync <vendorId>` → `POST /vendor/:id/model/sync.json`
- `gtgw vendor model add <vendorId> --file <json>` → `POST /vendor/:id/model/add.json`
- `gtgw vendor model update <vendorId> <modelId> --file <json>` → `PUT /vendor/:id/model/:modelId`
- `gtgw vendor model delete <vendorId> <modelId> [-y]` → `DELETE /vendor/:id/model/:modelId`
- `gtgw model list` → `GET /model/list.json`
- `gtgw model get <id>` → `GET /model/:id`
- `gtgw model create --file <json>` → `POST /model/create.json`
- `gtgw model update <id> --file <json>` → `PUT /model/:id`
- `gtgw model delete <id> [-y]` → `DELETE /model/:id`
- `gtgw model route-test --model <name> [--format ...]` → `POST /model/route-test.json`

#### 3.3 用户、余额、租户、规则
- `gtgw user list | get <id> | create --file <json> | update <id> --file <json>` → `/user/*`
- `gtgw user recharge <id> --amount <decimal> [--remark ...]` → `POST /user/:id/balance/adjust.json`
- `gtgw balance list` → `GET /balance/recharge/list.json`
- `gtgw balance get <id>` → `GET /balance/recharge/:id`
- `gtgw tenant list | get <id> | create --file <json> | update <id> --file <json> | delete <id> [-y]` → `/tenant*`
- `gtgw rule list | get <id> | create --file <json> | update <id> --file <json> | delete <id> [-y]` → `/rule/*`

#### 3.4 请求记录与复合运维命令
- `gtgw record list [--page 1] [--limit 20] [--model ...] [--user ...] [--status ...]` → `GET /record/list.json`
- `gtgw record get <id>` → `GET /record/:id`
- `gtgw record activity <id>` → `GET /record/:id/activity.json`
- `gtgw record delete <id> [-y]` → `DELETE /record/:id`
- `gtgw record recover-orphans` → `POST /record/recover-orphans.json`
- `gtgw record clear-payload [-y]` → `DELETE /record/clear-payload`
- `gtgw record clear-all [-y]` → `DELETE /record/clear-all`

**复合命令 1：`gtgw record clear-orphans [-y] [--limit 200]`**
1. 若未传 `-y`：非 TTY 报错退出（Code 2），TTY 提示确认。
2. 调用 `GET /record/clear-orphans/stats.json` 获取分母统计。
3. 持游标 `{ after_key, after_activity_id, limit }` 循环调用 `POST /record/clear-orphans/step`（对应 `recordController.ts` 游标协议），累加 `scanned_payloads`、`deleted_payloads`、`scanned_activities`、`deleted_activities` 并向 `stderr` 刷新进度，直至 `done == true`。

**复合命令 2：`gtgw record watch [--interval 2s]`**
1. 按 `--interval` 定时轮询 `GET /record/latest.json`。
2. 维护已打印记录 ID 的滑动集合（去重），仅增量输出新产生的请求摘要（时间、用户、模型、状态、耗时、费用）；`--json` 模式下每条新记录输出一行 NDJSON。

#### 3.5 客户端管理、API 测试与接入配置
- `gtgw client status` → `GET /client-config/status.json`
- `gtgw client local --client claude_code|codex` → `GET /client-config/local.json?client=...`
- `gtgw client create | apply | sync-from-local --file <json>` → 对应 `/client-config/*.json`
- `gtgw client backup create | rename | update | delete --file <json>` → 对应 `/client-config/backup*.json`
- `gtgw test models [--api-key <key>]` → `GET /llm/v1/models`
- `gtgw test chat|messages|responses [--api-key <key>] --model <m> [--prompt ...] [--file <json>] [--stream]` → `POST /llm/v1/chat/completions` / `/llm/v1/messages` / `/llm/v1/responses`
- `gtgw integration env [--shell bash|zsh|fish|powershell] [--api-key <key>]` → 本地生成 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 环境变量导出脚本（可直接 `eval "$(gtgw integration env)"`）。

---

## 构建、测试与分发集成

### 1. 构建与版本注入
在仓库构建脚本中统一读取根 `package.json` 的 `version`，通过 `-ldflags` 注入 `main.version`：
```bash
CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o dist/cli/gtgw .
```

### 2. Docker 多阶段构建集成
在现有 [Dockerfile](file:///Volumes/PDATA/GitDB/serverless_ai_gateway/Dockerfile) 中新增 `golang:1.22-alpine AS cli-builder` 阶段：
- 编译出静态二进制 `/out/gtgw`。
- 在最终运行阶段通过单行 `COPY --from=cli-builder /out/gtgw /usr/local/bin/gtgw` 拷贝（遵循 `Dockerfile` 中关于单行 `COPY` 兼容 `buildx` 跨架构构建的注释约定）。

### 3. 自动化测试
- **单元测试**：`internal/config`（优先级合并、0600 权限、Tauri 路径探测与 `0.0.0.0` 映射）、`internal/client`（SSE 三协议流式解析、错误码映射）、`internal/output`（Token 脱敏）。
- **集成测试**：使用 Go 标准库 `net/http/httptest` 启动 Mock 网关服务，覆盖 `login`、`clear-orphans` 多片游标循环、`--json` 输出纯净度与退出码验证。
- CI 中将 `cd cli && go test ./...` 纳入检查。

---

## 相关文档

- [产品文档](./step1_product.md)
- [开发任务表](./step3_tasks.md)（待编写）
