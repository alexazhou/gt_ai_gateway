# 上游请求超时与断连兜底 - 开发任务表

> 状态：规划中（尚未实施）

## 任务概览

任务按依赖排序：先落常量与配置（任务 1），再做上游响应头超时（任务 2），然后分别补非流式兜底（任务 3）与流式空闲超时（任务 4），最后加孤儿回收（任务 5）与测试回归（任务 6）。

> 状态标记：`[x]` 已完成，`[ ]` 待完成 / 待验证。

---

## 任务列表

### 任务 1: 常量与配置

**描述**: 新增失败码、配置项及默认值，供后续任务引用。

**依赖**: 无

**核心文件**:
- `src/constants.ts`
- `src/service/configService.ts`

**子任务**:
- [ ] `FailedCode` 增加 `UPSTREAM_TIMEOUT = "upstream_timeout"`、`RECOVERED_ORPHAN = "recovered_orphan"`
- [ ] `ConfigKey` 增加 `UPSTREAM_HEADERS_TIMEOUT_MS`、`UPSTREAM_NON_STREAM_TIMEOUT_MS`、`UPSTREAM_STREAM_IDLE_TIMEOUT_MS`、`ORPHAN_RECOVER_THRESHOLD_MS`
- [ ] `configService.CONFIG_DEFAULTS` 登记默认值：`900000` / `180000` / `180000` / `600000`
- [ ] 前端「高级设置」暴露超时/回收阈值配置项（可选，最后补）

**验收标准**:
- 未配置时 `getConfig` 返回默认值，超时时间可被读取

### 任务 2: 上游响应头超时

**描述**: 在 `sendRequestToUpstream` 的 fetch 处加「连接 + 响应头」超时，用 AbortController + setTimeout 组合客户端断开信号，fetch 返回后 clearTimeout。

**依赖**: 任务 1

**核心文件**:
- `src/service/senderService.ts`（fetch 处，约 L217）

**子任务**:
- [ ] 读取 `UPSTREAM_HEADERS_TIMEOUT_MS`
- [ ] 构造 controller + timer + `onClientAbort`，fetch 用 `controller.signal`
- [ ] fetch 后 `clearTimeout`，保留 `onClientAbort`（不 remove，保持 body 的中止语义）
- [ ] 确认超时/断开的 `AbortError` 与现有 `sendRequest` catch 的 failover / 冷却逻辑正确衔接

**验收标准**:
- 上游不响应时，超过响应头超时后请求结束，record 收尾（状态由任务 3/4 的收尾逻辑承担）
- 正常慢上游（响应头 < 超时）不受影响

### 任务 3: 非流式 body 超时 + 断连兜底

**描述**: 给两个非流式 handler 加 body 超时与 try/catch 兜底，异常时显式把 record 标 FAILED 并按原因写 `failed_code`。

**依赖**: 任务 1、2

**核心文件**:
- `src/service/responseHandlerService.ts`（`handleChatNonStreamResponse` 约 L227、`handleResponsesNonStreamResponse` 约 L517）

**子任务**:
- [ ] 读取 `UPSTREAM_NON_STREAM_TIMEOUT_MS`
- [ ] body 读取用 `Promise.race([upstreamRes.text(), timeout])`，超时 `upstreamRes.body.cancel()`
- [ ] 注册 `c.req.raw.signal` 的 abort 监听
- [ ] catch 里按 `c.req.raw.signal.aborted` / 超时 / 上游中断 区分 `failed_code`，更新 record FAILED + `end_at`，追加 RESULT 活动
- [ ] `finally` 里 `clearTimeout` + `removeEventListener`

**验收标准**:
- 上游返回头后 body 僵死：超时后 record 标 `FAILED`、`failed_code=upstream_timeout`
- 客户端断开：record 标 `FAILED`、`failed_code=client_disconnected`
- 不再出现 `processing` 孤儿记录（线上孤儿场景回归）

### 任务 4: 流式空闲超时

**描述**: 给两个流式 handler 加「相邻 chunk 空闲超时」，检测流式僵死，不影响长正常输出。

**依赖**: 任务 1

**核心文件**:
- `src/service/responseHandlerService.ts`（`handleChatStreamResponse` 约 L22、`handleResponsesStreamResponse` 约 L317）

**子任务**:
- [ ] 读取 `UPSTREAM_STREAM_IDLE_TIMEOUT_MS`
- [ ] 读循环里维护可重置的空闲计时器，每收到 chunk 重置
- [ ] 超时 `reader.cancel()` + `failedCode = UPSTREAM_TIMEOUT`
- [ ] 把 `UPSTREAM_TIMEOUT` 归入 `runInBackground` 收尾的失败分支（FAILED + `failed_code` + RESULT 活动）

**验收标准**:
- 上游流式输出中途僵死：空闲超时后 record 标 `FAILED`、`failed_code=upstream_timeout`
- 长时间正常流式输出（chunk 间隔 < 超时）不被误伤

### 任务 5: 孤儿记录回收（手动触发）

**描述**: 增加 `recordManager.recoverOrphans` 与管理接口，管理员可手动触发扫描并回收长期未结束的记录。

**依赖**: 任务 1

**核心文件**:
- `src/manager/recordManager.ts`
- `src/controller/recordController.ts`
- `src/routes.ts`

**子任务**:
- [ ] `recoverOrphans(thresholdMs)`：查 `status IN ('init','processing') AND end_at IS NULL AND start_at < cutoff`，逐条标 FAILED + `recovered_orphan` + `end_at`
- [ ] 追加 RESULT 活动（量大时评估批量写或省略）
- [ ] `recordController.recoverOrphans`：读取 `ORPHAN_RECOVER_THRESHOLD_MS`，调用 `recordManager.recoverOrphans`，返回 `{ recovered: N }`
- [ ] `routes.ts` 注册 `POST /record/recover-orphans.json`（`authMiddleware.requireAdmin`）
- [ ] 前端「记录」页/高级设置提供"扫描并回收孤儿记录"按钮（可选，最后补）
- [ ] 不接入启动流程：`local.ts` / `index.ts` 不做任何自动调用

**验收标准**:
- 手动触发扫描后，历史孤儿记录被标 FAILED，接口返回回收数量，前端不再显示「进行中」
- 阈值以内（未过期）的记录不受影响

### 任务 6: 测试与回归

**描述**: 覆盖超时与断连路径的自动化测试。

**依赖**: 任务 2-5

**核心文件**:
- 测试 mock 上游服务器（`doc/dev/TestManual.md` 中描述的 mock AI 服务器）
- 对应 handler / senderService 测试文件

**子任务**:
- [ ] 非流式 body 超时：mock 上游返回头后不发 body，断言超时后 record FAILED
- [ ] 非流式客户端断开：断言 `client_disconnected`
- [ ] 流式空闲超时：mock 上游发几个 chunk 后停住，断言 `upstream_timeout`
- [ ] 长流式输出不误伤
- [ ] 孤儿回收：预置一条过期 `processing` 记录，调用手动扫描接口后断言被回收
- [ ] `npm run backend:test:type` 通过

**验收标准**:
- Node 模式自动化测试全绿，worker 模式留 CI

---

## 依赖关系

```
任务 1 ──┬──> 任务 2 ──> 任务 3
         ├──> 任务 4
         └──> 任务 5
任务 6 <── 任务 2、3、4、5
```
