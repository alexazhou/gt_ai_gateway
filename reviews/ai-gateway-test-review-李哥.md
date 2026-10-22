# GT AI Gateway v1.9.0-beta1 — 测试与质量审查（李哥）

审查范围：测试套件实跑、覆盖率报告、边界条件、协议兼容性、安全测试视角。
审查时间：2026-10-22 23:50–00:05（本地）。

## 一、测试执行结果（实测）

| 命令 | 结果 | 耗时 |
|---|---|---|
| `TEST_MODE=node vitest --run --config vitest.config.ts`（= `npm run backend:test`） | **107 文件 / 1209 用例，全部通过** | 65s |
| `TEST_MODE=worker vitest --run --config vitest.worker.config.ts`（= `npm run backend:test:worker`） | **82 文件（81 通过 / 1 跳过）/ 1028 用例（1021 通过 / 7 跳过）** | 245s |
| `npx tsc --noEmit`（= `npm run backend:test:type`） | 通过（无类型错误） | ~40s |

口径说明：
- 任务描述称 123 个测试文件，仓库实际 `*.test.ts` 为 **107 个**（`tests/` + `src/`）。
- worker 配置 `exclude: ['**/*.node.test.ts']`，25 个 node 专有文件不进 worker 模式（107 − 25 = 82）。
- worker 跳过的 7 个用例集中在：客户端断开（`stream-failure` ×4、`upstream-timeout` ×2）、R2 对象存储链路（`objectStorageChain` ×1）。

## 二、覆盖率报告分析

`coverage/coverage-final.json`（生成于 2026-08-23，仓库内提交产物）：

- 统计 121 个 `src/**/*.ts` 文件，但**只有 3 个文件有任何覆盖数据**：`src/constants.ts` 100%、`src/util/rule/scopeExpr.ts` 98%、`src/customError.ts` 20%。
- 合计 **161 / 5166 语句 = 3.1%**，118 个文件为 0%。
- 结论：该报告是一次**定向小范围运行**的残留（对应 rule/scopeExpr 相关用例），**不能代表项目真实覆盖率**，放在仓库里会误导验收。
- CI（`.github/workflows/test.yml`、`deploy.yml`）**没有任何覆盖率任务或阈值**，覆盖率不参与门禁 → 覆盖薄弱模块无人兜底。

建议：CI 增 `npm run backend:test:coverage` + `coverage.thresholds`（先设 lines/functions 60%）；`coverage/` 加入 `.gitignore`，改为流水线产物。

## 三、问题清单

### P0

**无（本视角未复现 P0）**。鉴权矩阵、SSE 失败处理、协议转换主路径的用例实测均通过；`.dev.vars` 已被 `.gitignore` 排除、未被 git 跟踪；日志侧 token 走 `maskUtil.maskToken`，inspect 模式上游头用 `sanitizeUpstreamHeaders` 脱敏 —— 这几处做得好，不必误报。
（命令注入、限流/冷却 isolate 失效、计费非原子等 P0 见阿张清单。）

### P1（功能缺陷 / 数据正确性）

**P1-1 今日统计时区错位，UTC+8 下"今日"多算 8 小时**
- 位置：`src/controller/statsController.ts:15-16`（`today.setHours(0,0,0,0)` + `toISOString()`），使用于 `:31` 的 `WHERE created_at >= '${todayCutoff}'`。
- 事实依据：`record.created_at/start_at` 按**本地时区** `YYYY-MM-DD HH:mm:ss` 落库（`src/manager/recordManager.ts:167-175` 的 `formatDbDatetime` 注释明确写了这一点，raw 查询也必须用同格式）。
- 影响：`toISOString()` 把本地零点转成 UTC 字符串；在 UTC+8 下 cutoff 比真实本地零点早 8 小时 → **昨天 16:00–24:00 的记录被计入今日**，`today_requests / success_count / active_users / active_models / success_rate` 全部虚高。
- 复现：设置 `TZ=Asia/Shanghai` 启动 node 服务，插入一条"昨天 20:00（本地）"的 record，调用 `GET /stats/dashboard.json` → 该记录被算进 `today_requests`。
- 为什么现有用例抓不到：`tests/api/stats/stats.test.ts` 用 `datetime('now')`（UTC）插入，且 CI 跑在 `ubuntu-latest`（TZ=UTC），两边口径"刚好"一致 → 用例永远绿。
- 修复：生成 cutoff 时改用本地格式化（复用 `recordManager.formatDbDatetime` 或抽公共 util），并补一条 `TZ=Asia/Shanghai` 的统计用例。

**P1-2 SSE 跨 chunk 的 CRLF 归一化污染剩余缓冲，单个事件被拆成两个**
- 位置：`src/util/protocolUtil/sseEventUtil.ts:17-18`（对整个 buffer 做 `\r\n→\n`、`\r→\n` 后再 split，返回的 `remainingBuffer` 已是归一化后的文本）。
- 已实测复现：chunk1 = `"data: line1\r"`、chunk2 = `"\ndata: line2\r\n\r\n"`（上游一个事件的两行 data，CRLF 正好跨 chunk）→ 返回 2 个事件而不是 1 个 `data: "line1\nline2"`。临时用例断言 `[{data:"line1\nline2"}]` **失败**。
- 影响：多行 `data:` 事件（或任意在 chunk 边界被切开的 CRLF）会被错误拆帧 → 下游协议转换拿到半截 JSON → `failed_code=sse_parse_error`，且会向客户端下发空事件/错帧。
- 为什么用例抓不到：`tests/unit/util/protocolUtil/sseEventUtil.test.ts` 的 CRLF 用例都在单个字符串内完整给帧，**没有跨 chunk 边界的用例**。
- 修复：只在"已完成帧"上做归一化；`remainingBuffer` 保留原始片段（悬挂的 `\r` 留到下个 chunk 再判断），并补 chunk 边界用例（含 `\r`/`\n` 拆分、`data:` 多行）。

**P1-3 上游 SSE 读缓冲无上限，无 `\n\n` 时可打爆内存**
- 位置：`src/service/responseHandlerService.ts:93,149`（`buffer += chunk`，只在 `splitEvents` 里切帧，无长度上限）。
- 影响：上游返回 `text/event-stream` 但长时间不发空行（异常上游/半死连接/恶意上游），buffer 无界增长；Worker 内存 128MB 上限会直接 502，node 模式拖垮进程。
- 复现：mock 上游连续写不带 `\n\n` 的数据块（如每 50ms 写 1MB）。
- 修复：设置阈值（如 8MB），超限按 `sse_parse_error`/`upstream_error` 收尾并取消上游读；补一条用例。

**P1-4 上游 200 + 空 body / 非 JSON 体被记为 success 且不计费**
- 位置：`src/service/responseHandlerService.ts:392`（`statusCode === 200 ? SUCCESS : FAILED`）、`:413`（仅 `statusCode === 200` 时扣费）；判定依赖 `src/util/protocolUtil/upstreamFailureUtil.ts:80-83`（body 解析不出 JSON 直接返回 null）。
- 影响：上游/中间代理返回 `200` + 空串或 `text/html` 错误页时，`response_data` 落空、`status=success`、`cost=0`、活动日志记"请求成功"，客户端拿到一个"200 + 空 JSON 体"。既污染统计与计费，又让调用方拿到无法解析的响应。
- 复现：mock 上游对 `/chat/completions` 返回 `200` + `""`（或 `200` + `<html>...`），调用 `POST /llm/v1/chat/completions` → record.status = success。
- 测试缺口：全套用例中**没有任何非 JSON / 空响应体的上游用例**（grep `text/html`、`invalid-json` 均为 0 命中）。
- 修复：`responseText` 为空或协议必需字段（如 `choices` / `content` / `output`）缺失时，按 `upstream_error` 记 failed；同时保持响应透传。补空 body / HTML / 截断 JSON 三类用例。

**P1-5 OpenAI→Anthropic 转换缺省 `max_tokens=32768`，多数 Claude 上游会 400**
- 位置：`src/util/protocolConverter/OpenAIToAnthropicConverter.ts:128`。
- 影响：OpenAI 客户端经常不传 `max_tokens`（合法），转换后固定注入 32768；Claude 上游按模型上限（如 haiku 4096）校验 → `400 invalid_request_error`，failover 也会因为 4xx 不再切换上游，用户直接失败。
- 测试缺口：转换单测只覆盖了显式传 `max_tokens` 的场景。
- 修复：按上游模型上限钳制（vendor_model 上配置 `max_output_tokens`），或对未指定的情况取安全值（如 4096），并补"未传 max_tokens"用例。

**P1-6 管理端接口回传上游 vendor 明文 token 与代理配置**
- 位置：`src/controller/vendorController.ts:20`（`token: vendor.token`，`config: vendor.config`），被 `GET /vendor/list.json`、`GET /vendor/:id` 使用。
- 影响：任何持有 admin/root token 的调用方（含被 XSS 打穿的管理端、被浏览器缓存/代理记录的响应）都能一次性拉走该租户全部上游密钥与代理账号密码；对比：inspect 模式的 `sanitizeUpstreamHeaders` 已经做了脱敏，说明项目本身有该意识，两处口径不一致。
- 修复：列表/详情默认脱敏（`token` 只回前 4 位 + 掩码，`config.proxy.url` 去凭据）；编辑接口改成"留空 = 不修改"。

### P2（质量改进 / 测试缺口）

**P2-1 `checkBalance` 是死代码，余额门禁只在"已欠费"时生效**
- `src/service/userService.ts:116` 定义并导出 `checkBalance`，全仓库**无调用点**；实际门禁在 `src/service/senderService.ts:359-373`，只在 `user.balance < 0 && modelConfig.hasBilling()` 时拦截。
- 影响：注释（`userService.ts:81,109`）声称"扣减门槛统一由请求发起时的 checkBalance 预检负责"，与实现不符；余额恰为 0 时并发 N 个请求会全部放行并一起透支（扣费在响应完成后才发生）。
- 建议：要么删掉死代码并修正注释，要么在预检里按预估成本调 `checkBalance`；补"0 余额并发请求"用例。

**P2-2 2xx 非 200 响应被记为 FAILED 且不计费**
- 位置：`src/service/responseHandlerService.ts:392,413`。上游返回 201/204（少数兼容实现）时 `status=failed`、`cost=0`，但客户端拿到的是成功响应。
- 建议：判定改为 `statusCode >= 200 && statusCode < 300`。

**P2-3 无请求体大小上限**
- `src/middleware/llmApiMiddleware.ts:79` 直接 `await c.req.text()`，`src/routes.ts` 未挂 `bodyLimit`。Worker 有平台级限制兜底，node/桌面 sidecar 模式没有 → 超大 body 可打满内存。
- 建议：加 `bodyLimit`（如 32MB）并返回 413，补用例。

**P2-4 未知错误把内部信息回给调用方**
- 位置：`src/routes.ts:118`（`message: String(err)`）。非 LLM 路径的 500 会把原始 `err` 字符串（可能含 SQL/路径/堆栈片段）返回给调用方。
- 建议：非 `AppError` 统一回 `Internal server error`，细节只进日志。

**P2-5 `anthropic-version` 被写死**
- 位置：`src/service/senderService.ts:131`（`EXCLUDED_HEADERS` 剥掉客户端版本）、`:168`（固定 `2023-06-01`）。客户端指定更高版本时会被静默降级；`anthropic-beta` 未剥离，能透传（这点是对的）。
- 建议：透传客户端的 `anthropic-version`，缺省再回落 `2023-06-01`。

**P2-6 覆盖率产物失效且无门禁**（见第二节）→ 建议 CI 增加覆盖率任务与阈值，禁止提交 `coverage/`。

**P2-7 测试口径与用例命名问题**
- 测试文件数 107 vs 描述 123，文档口径需对齐。
- worker 模式跳过"客户端断开"6 个用例与 R2 对象存储 1 个用例 → `failed_code=client_disconnected`、R2 存储链路在**唯一真实运行环境（Worker）**实际无覆盖。
- `tests/api/ai/ai.negative.test.ts:257` 用例名写"should return 401 when model does not exist"，断言却是 `404 + not_found_error` —— 命名误导，排查时容易误判。
- 无 CORS 用例（`src/middleware/corsMiddleware.ts` 覆盖率 0）；`corsMiddleware` 对无 Origin 请求返回 `origin: "*"` 且 `credentials: true`，属浏览器非法组合，建议补断言（含 tauri://、localhost、跨站 origin 三种）。

## 四、建议补充的测试用例（按优先级）

1. `TZ=Asia/Shanghai` 下 `GET /stats/dashboard.json` 的"今日"边界（昨天 23:59 / 今天 00:01）。
2. `sseEventUtil` 跨 chunk 拆帧：`\r|\n` 拆分、多行 `data:`、心跳注释与数据事件混排。
3. 上游 200 + 空 body / HTML / 截断 JSON 三种非 JSON 场景 → record 必须 failed。
4. SSE 缓冲上限：无 `\n\n` 持续数据 → 必须在阈值内收尾（不能 OOM）。
5. OpenAI→Anthropic 未传 `max_tokens`、`tool_choice`、`response_format` 的组合转换。
6. 0 余额并发 N 请求 → 不得全部放行透支。
7. Worker 模式下客户端断开（现在被 skip）→ `failed_code=client_disconnected` 且不重复计费。
8. CORS 预检与跨站 Origin 拒绝。

## 五、结论

- 测试套件本身的**健康度很高**：1209（node）+ 1021（worker）用例全绿，类型检查通过；SSE 失败/超时/断流、协议转换（工具调用、多模态、thinking）、鉴权矩阵（401/403/disabled）覆盖扎实。
- 本轮测试视角的可修问题集中在**"只有跨时区/跨 chunk/非 JSON 上游才暴露"的边界条件**，以及**覆盖率无门禁 + 陈旧产物**这两类工程问题。
- 最优先修：P1-1（统计时区）、P1-2（SSE 拆帧）、P1-3（缓冲上限）、P1-4（空/非 JSON 响应记 success）、P1-6（vendor token 明文）。
