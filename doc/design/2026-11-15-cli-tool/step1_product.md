# 命令行工具（CLI） - 产品文档

> 状态：规划中（尚未实现）。日期为设计稿创建日期，落地后按发布 tag 日期归档。

## 目标

目前 Serverless AI Gateway 的所有管理操作（供应商、模型、用户、余额、规则、租户、请求记录、客户端配置与 API 测试等）均依赖 Web 管理后台或 Tauri 桌面端完成。在无头服务器、SSH 远程运维、CI/CD 流水线以及 AI Agent 自动化场景下，缺少一套与网页端能力对齐的命令行工具。

本需求为仓库新增一套官方 CLI 工具（命令名 `gtgw`），通过调用网关现有 REST API，实现**网页端全部功能在终端中的 1:1 覆盖**，并针对终端交互与脚本自动化提供多环境 Profile、JSON 管道输出、实时请求流监控与进度展示等能力。

## 功能特性

### 1. 认证、多环境 Profile、Key 存储与多租户视角

- **Profile 管理**：支持保存多个网关实例的连接配置（如 `local`、`prod`），记录 `baseUrl`、`token` 与默认 `tenant`，支持 `login` / `logout` / `profile list|use|remove` 切换或清理当前激活环境。
- **配置优先级**：命令行参数（`--url`、`--token`、`--tenant`、`--profile`） > 环境变量（`GTGW_URL`、`GTGW_TOKEN`、`GTGW_TENANT`） > 本地 Profile 配置文件。**没有第四层**：未配置任何 Profile 时 CLI 明确报「没有可用的网关地址」，绝不自动连接任何地址（本机桌面端也只以一种显式 Profile 的形式存在）。
- **Key（Token）存储机制**：
  - **存储位置**：全平台统一放在用户主目录下的 `.gtgw`：macOS / Linux 为 `~/.gtgw/config.json`，Windows 为 `%USERPROFILE%\.gtgw\config.json`（**不落 `%APPDATA%`**）；结构为 `active_profile` + `profiles` 映射，多套环境的 Token 彼此隔离。旧路径 `~/.config/gtgw/config.json`（以及 `XDG_CONFIG_HOME` 覆盖）**不再读取**，不做双读或静默迁移。
  - **文件权限保护**：在 POSIX 系统（macOS / Linux）下，自动创建目录权限为 `0700`、配置文件权限为 `0600`（仅当前用户可读写），防止同机其他用户读取。
  - **无盘化支持（CI / 容器）**：在 CI/CD 或临时脚本场景下，可直接通过 `GTGW_TOKEN` 环境变量或 `--token` 参数传入，无需执行 `login` 落盘。
  - **Tauri 桌面端联动**：支持读取桌面端持久化配置（macOS `~/Library/Application Support/GtCoder/AiGateway/config.json`、Windows `%APPDATA%\GtCoder\AiGateway\config.json`、Linux `${XDG_DATA_HOME:-~/.local/share}/GtCoder/AiGateway/config.json` 中的 `host`、`port` 与 `root_token`，其中 `0.0.0.0`/`::` 自动映射为 `127.0.0.1`）：
    - `gtgw login --from-tauri`：一键读取桌面端配置并校验 `/status.json` 后保存为一个 Profile（默认名 `tauri`，可用 `--profile` 改名）。这是使用本机桌面端的**唯一入口**，该 Profile 会带上「来自本机桌面端」的持久标记，`profile list` / `status` 会显示它的来源。
    - **不提供隐式自动回退**：未配置 Profile 时不会去探测桌面端配置自动连过去（旧行为已删除）。
  - **破坏性操作安全闸门**：当当前生效 Profile 带「来自本机桌面端」标记时（即地址与 Token 取自本机桌面端），`record clear-payload` / `record clear-all` / `recover-orphans` / `client apply` 等破坏性或覆盖类命令**默认拒绝执行**（退出码 `2`、不发任何请求）；`-y` 只表示「我知道这是破坏性操作」，不参与该判断，必须显式加 `--allow-local-destructive` 才放行，且放行时会打印当前 Profile 名与目标地址。其它来源（`--url` / `GTGW_URL` / 普通 Profile）不受影响。
  - **防泄露与清理**：`gtgw profile list`、`gtgw status` 等命令输出时自动对 Token 脱敏掩码（如仅保留前 4 位与后 4 位）；提供 `gtgw logout`（清除当前激活 Profile 的 Token）和 `gtgw profile remove <name>` 彻底删除凭证。
- **登录校验**：`gtgw login` 时调用 `GET /status.json` 验证服务可达性与 Token 有效性，展示当前用户角色（`root` / `admin`）与租户信息；交互式输入 Token 时隐藏明文回显。
- **多租户视角切换**：所有业务命令均支持全局参数 `--tenant <id|name>`，通过 `X-Tenant-ID` 请求头切换操作租户，行为与网页端顶部租户选择器一致；涉及仅 `main` 租户视角可用的接口（如全局配置写入、客户端配置管理、租户管理）时，若权限或视角不符，清晰透传服务端错误提示。

### 2. 输出格式与脚本自动化支持

- **人类可读模式（默认）**：列表命令以对齐表格输出核心字段，详情命令以键值摘要输出，长文本（如 Payload）默认做适当截断并提示查看完整内容的参数。
- **机器可读模式（`--json`）**：将接口返回的原始 JSON 直接输出到 `stdout`，提示信息与错误统一输出到 `stderr`，便于配合 `jq` 或自动化脚本解析。
- **精简模式（`--quiet` / `-q`）**：仅输出记录 ID 等关键标识，方便链式命令组合。
- **统一退出码**：区分执行成功（`0`）、业务/服务端错误（`1`）、参数校验错误（`2`）与鉴权/权限错误（`3`）。

### 3. 网页端全量功能覆盖

CLI 按资源域组织子命令，完整覆盖当前 Web 管理后台的所有页面能力：

| 网页模块 | CLI 命令域 | 核心能力 |
| :--- | :--- | :--- |
| 登录 / 系统状态 / 更新 | `login`、`profile`、`status`、`update` | 鉴权校验、多环境切换、系统状态与版本更新检查 |
| 仪表盘 | `dashboard` | 汇总统计指标与近期请求概览 |
| 设置 | `config` | 查看与修改全局配置（`GET/PUT /config.json`） |
| 供应商管理 | `vendor`、`vendor model` | 预置 URL 查询、供应商 CRUD、连通性测试；上游模型列表查看、远端拉取（fetch）、同步（sync）与单条增删改 |
| 模型管理 | `model` | 网关逻辑模型 CRUD、多上游路由策略配置、路由可用性测试（`route-test`） |
| 用户管理 | `user` | 用户列表、详情、创建、更新（启停/Token/限额等）、余额充值/调整 |
| 余额管理 | `balance` | 充值记录列表与单条详情查询 |
| 租户管理 | `tenant` | 多租户列表、详情、创建、更新与删除（系统管理员专用） |
| 规则管理 | `rule` | 限流与访问控制规则 CRUD |
| 请求记录 | `record` | 分页筛选查询、详情查看（含 Payload）、活动时间线（`activity`）、单条删除、孤儿恢复、清空 Payload、清空全部 |
| 客户端管理 | `client`、`client backup` | 查看各客户端接入状态、读取本机配置、创建/应用配置、从本地同步、备份的创建/重命名/更新/删除 |
| API 测试 | `test` | 发送 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 测试请求，及测试 `/llm/v1/models` |
| 接入配置 | `integration` | 本地生成可直接 `eval` 或复制的客户端环境变量与接入片段（OpenAI / Anthropic 等） |

### 4. 终端增强的复合能力

针对部分在网页前端由多步请求或交互编排实现的功能，CLI 侧提供原生复合命令：

- **分片清理孤儿记录（`gtgw record clear-orphans`）**：先请求 `GET /record/clear-orphans/stats.json` 获取待清理总量，再自动循环调用 `POST /record/clear-orphans/step` 直至完成，并在终端实时刷新进度条。
- **实时请求流监控（`gtgw record watch`）**：基于 `GET /record/latest.json` 定时轮询并增量去重打印最新请求记录，提供类似 `tail -f` 的终端监控体验。
- **流式 API 测试（`gtgw test chat|messages|responses --stream`）**：支持 SSE 流式响应的实时逐字输出与非流式完整打印，支持通过 `--file` 或标准输入（`stdin`）传入 Prompt/请求体。

### 5. 危险操作保护

- 对 `record clear-all`、`record clear-payload`、`record clear-orphans` 及各类 `delete` 操作，默认在交互终端提示二次确认。
- 提供 `--yes` / `-y` 参数用于显式跳过确认，以适配非交互式脚本。

### 6. 技术选型与分发方式

CLI 采用 **Go 语言**开发，源码放在当前仓库 `cli/` 目录下（独立 Go module），编译为**零外部运行时依赖的跨平台单文件原生二进制**（不依赖 Node.js），随仓库统一版本发布并支持以下分发路径：

- **GitHub Release 独立二进制（主路径）**：CI 自动交叉编译 macOS（arm64 / amd64）、Linux（amd64 / arm64）、Windows（amd64 / arm64）的 `gtgw` / `gtgw.exe` 单文件二进制并随 Release 发布，下载解压放入 `PATH` 即可运行。
- **Docker 镜像内置**：在 `Dockerfile` 中通过多阶段构建编译 `gtgw` 二进制并拷贝至最终镜像的 `/usr/local/bin/gtgw`（不保留 Go 编译环境，几乎不增加镜像体积），用户可通过 `docker exec -it <container> gtgw ...` 直接管理容器内网关实例。
- **Tauri 桌面端随附**：桌面端打包时可一并编译对应平台的 `gtgw` 二进制随安装包分发，并在后续支持从桌面端一键安装到系统 `PATH`。
- **源码编译安装**：开发者在本地通过 `go build` 或 `go install` 即可从 `cli/` 目录直接构建运行。

## 产品边界

- **纯 HTTP 客户端定位**：CLI 不直接连接 SQLite / MySQL / D1 数据库，也不绕过网关接口直接修改服务端状态，确保 Node / Docker / Cloudflare Workers 三种运行模式行为完全一致。
- **不引入复杂全屏 TUI**：本期专注于标准子命令（`<resource> <action>`）交互与管道友好的输出，不做类似 `htop` 的全屏curses/TUI 界面。
- **权限边界由服务端决定**：CLI 仅透传 Token 与 `X-Tenant-ID`，所有管理员、系统管理员与 `main` 视角校验完全以服务端响应为准。
- **不改变现有后端接口契约**：本需求优先复用现有后端 REST API，不要求为了 CLI 修改现有业务接口行为。

## 验收标准

- [ ] 支持 `login`（含 `--from-tauri`）、`logout`、`profile` 管理多套网关环境，配置统一落在 `~/.gtgw/config.json`（旧路径不读、无隐式回退），配置文件权限（`0600`/`0700`）与 Token 脱敏展示符合安全要求，并支持环境变量与命令行参数覆盖
- [ ] 全局支持 `--tenant` 切换多租户视角，以及 `--json`、`--quiet`、`--yes` 等通用参数
- [ ] 使用 Go 编译为单文件独立二进制，不依赖 Node.js 运行时，支持 macOS / Linux / Windows 交叉编译，且 Docker 镜像内可直接执行 `gtgw`
- [ ] 网页端全部 13 个功能模块（系统/设置、仪表盘、供应商、模型、用户、余额、租户、规则、请求记录、客户端管理、API 测试、接入配置）均有对应的 CLI 命令且可正常完成增删改查与专项操作
- [ ] `record clear-orphans` 能自动完成全部分片清理并展示进度，`record watch` 能持续增量输出新请求
- [ ] `test chat|messages|responses` 支持非流式与 `--stream` SSE 流式输出
- [ ] 危险操作在未传 `--yes` 时具备确认拦截机制；`--json` 模式下 `stdout` 仅输出合法 JSON

## 相关文档

- [技术文档](./step2_technical.md)（待编写）
- [开发任务表](./step3_tasks.md)（待编写）
