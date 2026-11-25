# Desktop Dev Mode — 技术设计

> 状态：设计稿，尚未实施。对应里程碑日期暂用当前日期，落地时归入正式目录并在 ROADMAP 标注状态。

## 1. 背景与问题

### 1.1 桌面端数据目录写死
Tauri 桌面端（`tauri/src-tauri/src/lib.rs`）在启动时把应用数据目录**写死**为系统默认应用数据目录下的固定子路径：

```rust
// lib.rs:656-661
let app_data_dir = app
    .path()
    .data_dir()
    .expect("failed to get data dir")
    .join("GtCoder")
    .join("AiGateway");
```

由此带来的问题：
1. **数据目录无法移动**：想换一块盘、换一个目录保存 `gateway.db` / 日志 / 配置，只能改源码重新编译。
2. **多实例 / 多环境无法隔离**：同一台机器上无法同时跑多份桌面端（每份各自独立的数据库与配置），只能互相覆盖同一个目录。
3. **无法用启动脚本控制**：命令行 / 脚本启动时没有任何开关能指定数据落盘位置。

### 1.2 缺少日志级别控制与流式 Chunk 调试输出
1. **桌面端 `config.json` 不支持设置日志级别**：目前 `read_config`（`lib.rs:521-573`）只读取 `port`、`host`、`root_token`，没有 `log_level` 字段，也不会向后端传递 `LOG_LEVEL`。
2. **`loggerUtil.ts` 无级别过滤**：`src/util/loggerUtil.ts` 与 `src/local.ts` 重写 `console.log/info/warn/error/debug` 时，所有级别无条件落盘，没有按 `log_level` 过滤。
3. **`debug` 级别下无法直接查看每个上游 Chunk 内容**：
   - 在 `src/service/responseHandlerService.ts` 的 `consumeUpstreamText` 中，`streamLogService.appendStreamLog(logStream, text)` 仅在 `stream_log_enabled=true`（即 `logStream !== null`）时才工作，且出于性能考虑（P2-12）只对第 1 个和每 200 个 chunk 打印一次长度摘要（`chunk #1, length: ...`）。
   - 当开发者将日志级别调为 `debug` 排查流式问题时，希望能**自动输出每一个上游 chunk 的完整内容**，而在默认 `info` 级别下保持采样摘要。

---

## 2. 目标与范围

1. **数据目录可配置**：引入环境变量 `GT_AI_GATEWAY_DATA_DIR`，让用户在启动 Tauri 桌面端时指定应用数据目录；未指定时保持默认目录。`config.json`、`gateway.db`、`logs/` 全部从数据目录派生。
2. **`config.json` 支持 `log_level`**：
   - 支持 `"debug"` | `"info"` | `"warn"` | `"error"`，**默认值为 `"info"`**；
   - Tauri 读取 `config.json` 中的 `log_level` 后，通过环境变量 `LOG_LEVEL` 传给后端 Node 进程（纯 Node 本地模式同样支持直接设置 `LOG_LEVEL` 环境变量）。
3. **流式 Chunk 按日志级别分级输出**：
   - **默认 `info` 级别**：输出采样 chunk 摘要（第 1 个及每 200 个 chunk 输出序号与长度），不输出 chunk 正文；
   - **`debug` 级别**：自动输出**每个上游 chunk 的完整内容**（无论数据库 `stream_log_enabled` 开关是否开启）。

---

## 3. 整体链路概览

```text
Tauri 启动 (lib.rs)
  ├─ 1. 解析数据目录：读 GT_AI_GATEWAY_DATA_DIR
  │     ├─ 非空 → 展开 "~"，校验目录必须已存在且为目录（否则报错退出）
  │     └─ 为空 → 默认 app.path().data_dir()/GtCoder/AiGateway（自动创建）
  ├─ 2. 读取 app_data_dir/config.json (read_config)
  │     └─ 解析 port / host / root_token / log_level（缺省或非法回退 "info"）
  └─ 3. 启动后端 sidecar (start_backend_process)
        └─ 注入环境变量 DB_PATH / LOG_DIR / PORT / HOST / ROOT_TOKEN / LOG_LEVEL

后端 Node 启动 (src/local.ts + src/util/loggerUtil.ts)
  ├─ 1. 读取 LOG_LEVEL（默认 "info"），初始化 Logger 最小输出级别
  ├─ 2. console.debug / console.log / console.warn / console.error 按级别阈值过滤输出与落盘
  └─ 3. 上游 SSE 流消费 (responseHandlerService.ts / streamLogService.ts)
        ├─ debug 级别 → 每个上游 chunk 自动 console.debug 输出序号、长度与完整文本内容
        └─ info 级别  → 每 200 个 chunk（含第 1 个）采样输出一条长度摘要
```

---

## 4. 桌面端数据目录设计（`GT_AI_GATEWAY_DATA_DIR`）

### 4.1 环境变量定义

| 项 | 值 |
|----|----|
| 变量名 | `GT_AI_GATEWAY_DATA_DIR` |
| 读取方 | Tauri Rust 主进程（`lib.rs` 的 `setup`） |
| 取值 | 目录路径字符串 |
| 语义 | 非空且非空白 → 作为应用数据目录；空/未设置 → 退回默认目录 |
| 建议取值 | 绝对路径（如 `/Users/me/.gt-gateway`）或 `~/...` |

### 4.2 数据目录解析规则

优先级固定为：**环境变量 > 默认值**，无中间层。

1. 读取 `GT_AI_GATEWAY_DATA_DIR`，`trim()` 后为空 → 用默认目录 `app.path().data_dir().join("GtCoder").join("AiGateway")`，沿用现有 `create_dir_all` 自动创建。
2. 非空 → 显式指定目录：
   - 支持 `~` 或 `~/...` 展开为用户主目录（通过 `app.path().home_dir()` 或 `HOME` / `USERPROFILE` 展开）。
   - **目录必须已存在且为目录**：不存在或指向文件时，报错并终止启动，不自动创建、不回退默认目录。

派生关系（沿用现有代码，自动跟随 `app_data_dir`）：

| 派生项 | 计算方式 | 现有位置 |
|--------|---------|---------|
| `config.json` | `app_data_dir/config.json` | `lib.rs:522` |
| `gateway.db` | `app_data_dir/gateway.db`（作为 `DB_PATH` 传给后端） | `lib.rs:667` |
| 日志目录 | `app_data_dir/logs`（作为 `LOG_DIR` 传给后端） | `lib.rs:663` |

---

## 5. `config.json` 日志级别与流式 Chunk 输出设计

### 5.1 `config.json` 结构扩展

在 `tauri/src-tauri/src/lib.rs` 中扩展 `AppConfig` 与 `BackendLaunchConfig`：

```json
{
  "port": 6722,
  "host": "127.0.0.1",
  "root_token": "b3d7...",
  "log_level": "info"
}
```

- **常量定义**：`const DEFAULT_LOG_LEVEL: &str = "info";`
- **合法值归一化函数 `normalize_log_level(raw: &str) -> Option<String>`**：
  - `trim().to_ascii_lowercase()` 后匹配 `"debug" | "info" | "warn" | "error"`；
  - 匹配成功返回对应小写字符串，否则返回 `None`（调用方回退为 `"info"`）。
- **`read_config` 读写逻辑**：
  - 读取 `json["log_level"].as_str()`，经 `normalize_log_level` 校验后赋给 `log_level`（缺省或非法时使用 `"info"`）；
  - 当触发首次创建或补全 `root_token` 写回文件（`need_write == true`）时，一并写入 `"log_level": log_level`。
- **传递给后端 Sidecar**：
  - `BackendLaunchConfig` 新增 `log_level: String`；
  - `start_backend_process` 中增加 `.env("LOG_LEVEL", &launch_config.log_level)`。

### 5.2 后端 Logger 级别过滤（`src/util/loggerUtil.ts` & `src/local.ts`）

1. **日志级别定义与权重**：
   ```ts
   export type LogLevel = "debug" | "info" | "warn" | "error";

   const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
       debug: 10,
       info: 20,
       warn: 30,
       error: 40,
   };
   ```
2. **解析环境变量 `LOG_LEVEL`**：
   - 新增 `parseLogLevel(raw?: string): LogLevel`：将输入转为小写，若属于 `debug | info | warn | error` 则返回，否则默认返回 `"info"`。
   - `Logger` 实例保存当前生效的 `minLevel: LogLevel`（默认从 `process.env.LOG_LEVEL` 解析，也可通过 `LoggerOptions.level` 或 `setLevel(level)` 指定），并提供 `shouldLog(level: LogLevel): boolean` 与 `isDebugEnabled(): boolean` 辅助方法。
3. **统一拦截控制台输出与文件写入**：
   - `Logger.write(level, ...)` 内部先判断 `if (!this.shouldLog(level)) return;`，低于当前级别的日志不写文件。
   - `src/local.ts` 重写 `console.debug` / `console.log` / `console.warn` / `console.error` 时，同样先检查 `logger.shouldLog(level)`：
     - 例如默认 `LOG_LEVEL=info` 时，`console.debug(...)` 既不打印到终端 stdout，也不写入 `app-YYYY-MM-DD.log`；
     - 当 `LOG_LEVEL=debug` 时，`console.debug(...)` 同时输出到终端和日志文件。
4. **补齐跨天切换与启动时的旧日志清理（`pruneOldFiles`）**：
   - 现状缺陷：`Logger` 虽然定义了 `DEFAULT_MAX_FILE_COUNT = 5`（最多保留 5 个 `app-*.log` 文件），但此前仅在单文件写满 100MB 触发 `rotate()` 时才调用 `this.pruneOldFiles()`；若每天日志不足 100MB，跨天切换（`rollOverIfNewDay()`）或重启跨天时不会触发清理，导致历史按天日志文件无限累积。
   - 修复方式：
     - 在 `Logger` 构造函数初始化完成时调用一次 `this.pruneOldFiles()`；
     - 在 `rollOverIfNewDay()` 跨天切换到新文件并写入新一天第一条日志后（或创建新一天日志文件后），调用 `this.pruneOldFiles()`，确保无论按大小轮转还是按天滚动，目录中始终最多保留最新的 5 个 `app-*.log` 文件。

### 5.3 上游流式 Chunk 日志行为（默认 `info` 采样，`debug` 逐 Chunk 输出内容）

当前 `streamLogService.appendStreamLog(logStream, chunk)` 存在两个耦合问题：
1. 入口第一行 `if (!logStream) return;` 导致当 `stream_log_enabled=false` 时，哪怕把日志级别调成 `debug` 也完全没有 chunk 日志；
2. 它没有感知当前的日志级别 `debug` vs `info`。

**改造方案**：

在 `src/service/streamLogService.ts`（或配合 `responseHandlerService.ts`）中解耦「控制台/应用日志输出」与「独立 `stream/*.log` 文件落盘」：

```ts
/**
 * 记录上游流式 chunk（应用日志 + 可选的独立流日志文件）。
 *
 * - debug 级别：自动输出每一个上游 chunk 的完整内容（console.debug）
 * - info 级别（默认）：仅在第 1 个及每 200 个 chunk 输出一次采样摘要（console.log）
 * - 若开启了 stream_log_enabled（logStream 非空），同时将原始 chunk 写入 log/stream/<recordId>.log
 */
export function recordUpstreamChunk(
    recordId: number | string,
    chunkIndex: number,
    chunk: string,
    logStream: WriteStream | null,
): void {
    const logger = getLogger();
    if (logger?.isDebugEnabled()) {
        console.debug(
            `[streamLogService] [record=${recordId}] chunk #${chunkIndex} (length=${chunk.length}): ${chunk}`,
        );
    } else if (chunkIndex === 1 || chunkIndex % CHUNK_LOG_SAMPLE_EVERY === 0) {
        console.log(`[streamLogService] [record=${recordId}] chunk #${chunkIndex}, length: ${chunk.length}`);
    }

    if (logStream) {
        logStream.write(chunk);
    }
}
```

> **兼容性保留**：保留原有的 `appendStreamLog(logStream, chunk)` 方法（或在其内部复用同一逻辑）以兼容现有调用与单测；在 `responseHandlerService.ts` 的 `runSSELoop` 内维护 `chunkIndex` 计数器并调用上述逻辑。
>
> 这样：
> - **默认 `info` 下**：每个流式请求在第 1、200、400... 个 chunk 时输出一条 `[INFO] [streamLogService] [record=...] chunk #1, length: ...`（无论是否打开 `stream_log_enabled`，都能在 `info` 日志里看到流式 chunk 采样心跳）；
> - **`debug` 下**：每个上游 chunk 都会通过 `console.debug` 输出完整内容（含 SSE `event:` / `data:` 原始帧），无需进后台开关 `stream_log_enabled` 即可直接排查。

---

## 6. 代码改动点汇总

| 文件 | 改动内容 |
|------|----------|
| `tauri/src-tauri/src/lib.rs` | 1. 新增 `resolve_data_dir` 读取 `GT_AI_GATEWAY_DATA_DIR`（含 `~` 展开与目录存在性校验）；<br>2. `AppConfig` / `BackendLaunchConfig` 新增 `log_level`（默认 `"info"`），`read_config` 解析并持久化 `log_level`；<br>3. `start_backend_process` 向后端注入 `.env("LOG_LEVEL", &log_level)`。 |
| `tauri/src-tauri/src/utils.rs` | 抽离纯函数 `resolve_custom_data_dir` 与 `normalize_log_level`，便于编写 Rust 单元测试。 |
| `src/util/loggerUtil.ts` | 1. 新增 `parseLogLevel`、`shouldLog(level)`、`isDebugEnabled()`，支持从 `process.env.LOG_LEVEL`（默认 `"info"`）或 `LoggerOptions.level` 初始化日志级别阈值；<br>2. 在 `Logger` 初始化与 `rollOverIfNewDay()` 跨天切换时调用 `pruneOldFiles()`，补齐按天滚动时的文件数量上限（5 个）清理。 |
| `src/local.ts` | 重写 `console.log/warn/error/debug` 时按 `logger.shouldLog(level)` 过滤终端输出与文件落盘；启动日志打印当前 `LOG_LEVEL`。 |
| `src/service/streamLogService.ts` & `src/service/responseHandlerService.ts` | 流式读取上游 chunk 时：默认 `info` 级别按采样输出 chunk 序号与长度摘要；`debug` 级别自动输出每个上游 chunk 的完整内容。 |
| `doc/dev/TauriDevManual.md` | 补充 `GT_AI_GATEWAY_DATA_DIR` 与 `config.json` 中 `log_level` 的说明，同步修正 `DESKTOP_MODE` 过时描述。 |

---

## 7. 边界情况与错误处理

| 场景 | 行为 |
|------|------|
| `GT_AI_GATEWAY_DATA_DIR` 未设置 / 空 / 全空白 | 退回默认目录，自动创建，与现状完全一致 |
| `GT_AI_GATEWAY_DATA_DIR` 指向不存在的路径或文件 | 报错并终止启动，不自动创建、不回退默认目录 |
| `config.json` 缺少 `log_level` 字段（老版本升级） | 默认按 `"info"` 运行，不破坏已有配置 |
| `config.json` 中 `log_level` 填写了非法值（如 `"verbose"`） | 自动回退为 `"info"` |
| `config.json` 中 `log_level` 为大写（如 `"DEBUG"`） | 大小写不敏感，归一化为 `"debug"` 生效 |
| `log_level = "debug"` 且 `stream_log_enabled = false` | 应用日志（控制台 + `app-YYYY-MM-DD.log`）照常输出每个上游 chunk 的完整内容；不生成 `log/stream/<id>.log` 独立文件 |

---

## 8. 验证策略

1. **Rust 单测（`cargo test`）**：
   - 测试 `resolve_custom_data_dir`：空值返回 `None`、`~` 展开、已存在目录成功、不存在路径报错、指向普通文件报错；
   - 测试 `normalize_log_level`：`debug`/`INFO`/`Warn`/`error` 归一化，空值或非法值回退 `"info"`。
2. **后端单测（Vitest）**：
   - 测试 `loggerUtil` 不同 `LOG_LEVEL`（`debug` / `info` / `warn` / `error`）下的过滤行为；
   - 测试 `loggerUtil` 在跨天切换（未达单文件 100MB 阈值）及初始化时同样触发 `pruneOldFiles()`，严格只保留最新 `maxFileCount`（默认 5）个 `app-*.log` 文件；
   - 测试 `streamLogService` 在 `info` 级别下仅采样输出 chunk 长度、在 `debug` 级别下输出每个上游 chunk 的完整内容。
3. **构建与类型检查**：
   - `npm run backend:test:type` 通过；
   - `cargo check` / `cargo test` 通过。
