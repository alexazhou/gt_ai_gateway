# 上游请求超时与断连兜底 - 技术文档

> 状态：规划中（尚未实施）

## 架构概览

在「发起上游请求 → 读响应体」链路上补三块兜底，全部落在既有 `controller → service → manager → model` 分层内，不引入新模块：

```
senderService.sendRequestToUpstream
  └─ fetch(..., signal: 组合信号)              ← ① 响应头超时
      ├─ 流式   → responseHandlerService.handleStreamResponse      ← ② 流式空闲超时
      └─ 非流式 → responseHandlerService.handleNonStreamResponse   ← ③ 非流式 body 超时 + 断连兜底

管理接口 recordController.recoverOrphans
  └─ recordManager.recoverOrphans(...)        ← ④ 孤儿记录回收（手动触发）
```

核心思路：**超时只检测「僵死」，不设整条请求总超时**。用「响应头超时 + 非流式 body 分段超时 + 流式空闲超时」组合，避免误伤合法长耗时（长流式输出、慢上游）。

## 命名落地

| 概念 | 命名 |
|------|------|
| 失败码（超时） | `FailedCode.UPSTREAM_TIMEOUT = "upstream_timeout"` |
| 失败码（回收） | `FailedCode.RECOVERED_ORPHAN = "recovered_orphan"` |
| 配置项 | `ConfigKey.UPSTREAM_HEADERS_TIMEOUT_MS`（默认 `900000`） |
| 配置项 | `ConfigKey.UPSTREAM_NON_STREAM_TIMEOUT_MS`（默认 `180000`） |
| 配置项 | `ConfigKey.UPSTREAM_STREAM_IDLE_TIMEOUT_MS`（默认 `180000`） |
| 配置项 | `ConfigKey.ORPHAN_RECOVER_THRESHOLD_MS`（默认 `600000`） |
| Manager 方法 | `recordManager.recoverOrphans(thresholdMs)` |

新增配置默认值统一登记在 `configService` 的 `CONFIG_DEFAULTS` 中，沿用现有 `getConfig` 内存缓存。

## 决策记录

| 决策点 | 结论 | 说明 |
|--------|------|------|
| 超时粒度 | **分阶段，不做总超时** | 总超时会误伤长流式/慢上游；核心诉求是检测僵死 |
| 超时来源 | **全局配置，不按 vendor 细化** | 保持简单，后续需要再增强 |
| 超时实现 | **AbortController + setTimeout** | Node 22 与 Workers 均支持；比 `AbortSignal.timeout` 更便于「fetch 返回后重新武装计时器」 |
| 流式超时 | **空闲超时（idle）** | 每收到一个 chunk 重置计时，长输出不误伤 |
| 非流式超时 | **body 总超时** | 非流式读的是完整 body，用总时长 |
| 孤儿回收时机 | **手动触发** | 不自动执行，由管理员经管理接口手动扫描；避免启动开销与 Worker 多 isolate 并发写 |
| 回收失败码 | **独立 `recovered_orphan`** | 与运行期检测到的 `upstream_timeout` 区分，便于运营识别 |

## 核心改动点

按请求链路分段设置超时与失败兜底，各段口径独立、互不干扰：

### ① 响应头超时（发起上游请求处）

**机制**：为「连接 + 响应头」阶段设置超时。利用 fetch 在收到响应头即返回的特性，让计时在收到响应头后失效，从而超时只约束建连与等待响应头这一段；客户端断开信号与超时合并为一个中止信号，客户端随后断开仍能中断尚未读完的响应体。

**超时口径**：从发起请求到收到响应头。

**失败处理**：超时/断开与普通网络错误汇入已有的失败处理链路，按原因记录 `failed_code`，并沿用既有的 failover / 冷却逻辑。

**兜底场景**：上游连不上、一直不返回响应头。

### ② 流式空闲超时（流式响应读循环）

**机制**：流式是持续输出的长连接，不适合设整段总时长，改以「相邻 chunk 之间的最大空闲时间」判定僵死。每次收到一个 chunk 重置计时，因此只掐「长时间无数据」的停顿，不影响长输出正常节奏。

**超时口径**：相邻两个 chunk 的间隔（事件处理、向客户端转发耗时不计入）。

**失败处理**：超时后取消上游流，并作为一条独立的失败原因收尾记录，与既有断连/错误原因并行。

**兜底场景**：上游流式输出中途僵死。

### ③ 非流式 body 超时 + 断连兜底（非流式响应 body 读取）

**机制**：非流式一次性读完整 body，以「读取总时长」作为超时口径；同时补齐客户端断开的感知（原实现缺失，是孤儿记录的根因）。由于响应体读取不支持传入中止信号，通过中止信号触发 body 取消来中断读取。

**超时口径**：开始读取至 body 读完的总时长。

**失败处理**：读取中断按原因（客户端断开 / 超时 / 上游中断）区分，并**显式更新记录状态**后结束——不能依赖上层对断开的既有处理，这正是孤儿记录产生的原因。

**兜底场景**：上游返回响应头后 body 僵死；客户端读完整响应的中途断开。

### ④ 孤儿记录回收（手动扫描接口）

**机制**：提供管理接口（`POST /record/recover-orphans.json`，管理员权限）手动触发扫描：查出 `init` / `processing` 且 `end_at` 为空、自 `start_at` 起超过阈值仍未结束的记录，统一标为失败并写 `recovered_orphan` 原因、补收尾时间与活动，接口返回回收数量。为了控制开销，数量大时活动可批量写或省略；**不接入启动流程**（local.ts / index.ts 不做自动调用），避免启动开销与并发写冲突。

**时间口径**：载入 `ORPHAN_RECOVER_THRESHOLD_MS` 阈值（默认 10 分钟），记录自 `start_at` 起超过阈值仍未结束视为孤儿。

## 兼容性

- 三态运行（Node / Cloudflare Workers / Tauri）都要覆盖：`AbortController` / `setTimeout` / `AbortSignal` 在三态均可用，无新增依赖。
- 孤儿回收为手动触发，不依赖长驻进程与 scheduled/cron trigger；Worker / Node / Tauri 三态下行为一致。
- 响应头超时默认 900s，属纯兜底（极宽松，只防「连不上 / 一直不回头」的僵死）；非流式 body 与流式空闲均为 180s 相对保守。各项超时均需用线上真实数据（如线上 42s 慢响应案例）校准。

## 与既有逻辑的关系

- **failover / 冷却**：超时/断连都会先完成记录收尾，再汇入既有失败处理链路。超时与网络类异常以非 HTTP 错误进入该点，`upstreamHealthService.shouldMarkFailure(null)` 恒返回 true，因此超时与 body 僵死都会触发上游冷却；failover 开启时继续尝试下一个上游，同一请求跨次尝试复用同一条记录。
- **原有断连处理**：流式分支已有的客户端断连逻辑保持不变，只在其上新增空闲超时；非流式分支原本缺失断连感知与收尾（孤儿记录根因），本次补齐，另以手动回收兜底历史脏数据。
