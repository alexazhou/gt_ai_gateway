# Desktop Dev Mode — 产品设计

> 状态：设计稿，尚未实施。对应里程碑日期暂用当前日期，落地时归入正式目录并在 ROADMAP 标注状态。

## 1. 背景与目标

当前桌面端（Tauri）在启动与日志诊断方面存在两个痛点：

1. **数据目录固定写死**：桌面端启动时固定把数据目录放到系统应用数据目录下的 `GtCoder/AiGateway`，既无法迁移到其他磁盘或目录，也无法在同一台机器上通过脚本启动多份互不干扰的桌面端实例。
2. **缺少日志级别控制与流式 chunk 明细诊断**：桌面端 `config.json` 仅支持 `port`、`host`、`root_token`，无法控制后端日志输出粒度。生产稳态下，为了避免日志洪水和事件循环开销，流式响应仅每 200 个 chunk 打一条长度采样日志；但在排查上游 SSE 分帧异常、协议转换丢字段等问题时，开发者希望能直接通过配置文件开启 `debug` 级别，在应用日志中逐个查看上游返回的每个 chunk 原始内容。

**本迭代目标**：

1. 支持通过环境变量 `GT_AI_GATEWAY_DATA_DIR` 指定桌面端的数据目录（`config.json`、`gateway.db`、`logs/` 自动跟随该目录）。
2. 在桌面端 `config.json` 中新增 `log_level` 配置项（默认 `"info"`），传递至后端控制日志级别。
3. 明确 `info` 与 `debug` 级别下的流式 chunk 日志行为：
   - **`info`（默认）**：维持现有的采样简要日志（第 1 个及每 200 个 chunk 输出序号与字节长度）；
   - **`debug`**：自动输出**每个上游 chunk 的完整内容**，无需额外开启流式落盘开关即可在控制台与应用日志中直接排查流式问题。

---

## 2. 功能特性

### 2.1 环境变量指定数据目录（`GT_AI_GATEWAY_DATA_DIR`）

- **未设置或为空**：保持现状，使用系统默认应用数据目录（如 macOS 下 `~/Library/Application Support/GtCoder/AiGateway`），不存在时自动创建。
- **显式设置非空路径**：
  - 支持前导 `~` 展开为用户主目录（如 `~/my-gateway-data`）；
  - **目标路径必须已存在且为目录**：若路径不存在或指向普通文件，启动立即报错终止，**不自动创建、不静默回退默认目录**（防止拼写错误导致连错空库）；
  - 目录下的 `config.json`、`gateway.db`、`logs/` 以及托盘菜单「打开配置目录」全部基于该目录派生。

### 2.2 `config.json` 支持设置 `log_level`

桌面端数据目录下的 `config.json` 新增 `log_level` 字段：

```json
{
  "port": 6722,
  "host": "127.0.0.1",
  "root_token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "log_level": "info"
}
```

- **可选值**（大小写不敏感，统一归一化为小写）：`debug` | `info` | `warn` | `error`。
- **默认值**：`"info"`。
  - 新生成 `config.json` 时默认写入 `"log_level": "info"`；
  - 存量 `config.json` 未包含 `log_level` 字段或值非法时，运行时按 `"info"` 处理。
- **级别过滤语义**（优先级 `debug < info < warn < error`）：
  - 当 `log_level` 设为 `"info"`（默认）时，输出 `info` / `warn` / `error` 日志，不输出 `debug` 日志；
  - 当 `log_level` 设为 `"debug"` 时，开启全部日志（含 `console.debug` / `logger.debug`）。

### 2.3 上游流式 Chunk 日志分级输出

针对流式响应（SSE）接收到的每一个上游文本分片（chunk）：

| 日志级别 | 上游 Chunk 日志行为 | 适用场景 |
|----------|---------------------|----------|
| `info`（默认） | **采样摘要**：仅在第 1 个及每 200 个 chunk 输出一条 `[streamLogService] chunk #N, length: L`，不打印 chunk 正文 | 日常运行与生产环境，兼顾「流仍在推进」的可观测性与低 I/O 开销 |
| `debug` | **逐 Chunk 完整内容**：对每一个收到的上游 chunk，除摘要外自动以 `debug` 级别输出序号、长度与**完整文本内容**（例如 `[streamLogService] [recordId=...] chunk #N (length=L): <content>`） | 本地调试、桌面端排查上游流式分帧/字段缺失问题，改完 `config.json` 重启即可见 |
| `warn` / `error` | 不输出 chunk 级日志 | 仅关注告警与错误 |

> **注意**：`debug` 级别输出每个上游 chunk 内容是**应用日志层**（stdout + `app-YYYY-MM-DD.log`）的能力，**不依赖**数据库配置项 `stream_log_enabled`（即使未开启 `stream/xxx.log` 独立文件落盘，只要 `log_level` 为 `debug`，就会输出每个上游 chunk 的内容）。同时应用日志受 `loggerUtil` 的自动轮转保护（单文件最大 100MB、最多保留 5 个 `app-*.log` 文件），本迭代同步补齐**跨天切换与启动时的旧日志清理**，确保每天日志不足 100MB 时也不会超过 5 个文件上限。

---

## 3. 产品边界（非目标）

- **不新增独立环境变量覆盖 `port` / `host` / `root_token`**：避免环境变量与 `config.json` 出现双套优先级冲突；需要隔离配置时通过切换 `GT_AI_GATEWAY_DATA_DIR` 实现。
- **不针对不存在的自定义数据目录做自动创建**：自定义目录通常是挂载盘或事先准备好的工作区，路径不存在往往意味着配置拼写错误或外置盘未挂载，显式报错比静默建空库更安全。
- **Cloudflare Workers 模式不受影响**：`config.json` 与 `loggerUtil` 文件落盘属于桌面端 / Node 本地运行模式能力。

---

## 4. 验收标准

- [ ] 不设置 `GT_AI_GATEWAY_DATA_DIR` 启动桌面端，数据目录仍为系统默认目录，行为与改造前完全一致
- [ ] 设置 `GT_AI_GATEWAY_DATA_DIR` 指向已存在的目录（含 `~/...` 形式），`config.json`、`gateway.db`、`logs/` 均落在该目录下，托盘「打开配置目录」打开该目录
- [ ] 设置 `GT_AI_GATEWAY_DATA_DIR` 指向不存在的路径或文件，桌面端报错并终止启动，不自动创建目录、不回退默认目录
- [ ] 首次生成 `config.json` 时包含 `"log_level": "info"`；存量无 `log_level` 的 `config.json` 默认按 `info` 级别运行
- [ ] 默认 `log_level: "info"` 下发起流式请求，日志仅输出采样进度（第 1 个及每 200 个 chunk 的长度），不输出每个 chunk 的正文内容
- [ ] 将 `config.json` 的 `log_level` 改为 `"debug"`（或 Node 模式设置 `LOG_LEVEL=debug`）后发起流式请求，日志自动输出每个上游 chunk 的完整内容
- [ ] 将 `log_level` 设为 `"warn"` 或 `"error"` 时，`info` 与 `debug` 级别日志不再写入日志文件与控制台
- [ ] 后端测试（node 模式）、TypeScript 静态类型检查、`cargo check`/`cargo test` 均通过

## 相关文档

- [技术文档](./step2_technical.md)
