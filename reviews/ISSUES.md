# GT AI Gateway v1.9.0-beta1 问题台账（ISSUES）

> 汇总来源：`reviews/ai-gateway-code-review-阿张.md`（代码与安全）、`reviews/ai-gateway-test-review-李哥.md`（测试与质量）、`reviews/regression-cases-p0-李哥.md`（回归用例）
> 去重后合计 **37 项：P0 × 4、P1 × 11、P2 × 22**
> 状态口径：`TODO` / `IN_PROGRESS` / `FIXED(待验)` / `VERIFIED` / `WONTFIX`
> 更新规则：修完由执行人改为 `FIXED(待验)`，验收通过后改为 `VERIFIED`。

---

## P0 — 严重（安全漏洞 / 数据一致性）

| 编号 | 问题 | 位置 | 负责人 | 状态 | 修复方案 |
|---|---|---|---|---|---|
| P0-1 | **命令注入**：SQL 仅转义 `"` 后拼进 `--command="..."` 交给 shell，`$()`、反引号、`;` 可执行任意命令（`dbName`、`configPath` 同样未校验） | `src/util/db/wranglerDBAdapter.ts:23,38,44` | 阿张 | FIXED(待验) | 改 `execFileSync("npx", [...])` 参数数组绕开 shell；超长 SQL 走临时文件 `--file`；`dbName`/`configPath` 加 `/^[\w.\-/]+$/` 白名单；顺带修"`\n`→空格"会改坏 SQL 字面量的问题 **已改（分支 `fix/p0-security-billing`）**：`execSync`→`execFileSync("npx", argv[])`（不进 shell）；>32KB SQL 走临时文件 `--file`；新增 `src/util/db/cliArgUtil.ts` 复用白名单（拒绝 `..`/非法字符），`dbMigrationService` 的合并迁移分支与 DROP 表循环一并收口（原 `execSync(cmd)` 同类注入点）；取消 `\n`→空格替换。守卫用例 `tests/unit/security/no-shell-string-exec.test.ts` 已转绿。 |
| P0-2 | **限流在 Worker 下失效**：令牌桶是 isolate 内 Map，实际 rpm ≈ 配置 × isolate 数，规则可成倍绕过 | `src/service/rateLimitService.ts:12,55`；`src/util/rule/memoryRateLimitStore.ts` | 阿张 | TODO | Worker 模式改用 Durable Object 原子令牌桶，或 D1 条件原子 UPDATE；`setStore()` 已预留注入点 |
| P0-3 | **上游故障冷却失效**：30s 冷却同样是 isolate 内状态，故障上游被持续打；`cacheService` 裸 Map 无 TTL/淘汰，Node 常驻模式只增不减 | `src/service/upstreamHealthService.ts:40,65`；`src/service/cacheService.ts:1` | 阿张 | TODO | 与 P0-2 同一套共享存储（DO 或 KV，KV 接受最终一致）；`cacheService` 加 `maxSize` + LRU/TTL 清扫 |
| P0-4 | **计费与记录非原子**：先 `recordService.update` 写 usage+cost，再 `deductBalance`，两步独立提交；中途失败即钱账不一致且无补偿 | `src/service/responseHandlerService.ts:222/238`（流式）、`:395/414`（非流式） | 阿张 | FIXED(待验) | 加 `ormService.transaction()` 抽象（SQLite `execTransaction` / D1 `batch` / MySQL `beginTransaction`），记录+扣费+活动日志三步同事务；`isModuleBillingEnabled()` 在事务外取；失败 catch 后落可见日志 **已改（分支 `fix/p0-security-billing`）**：新增 `ormService.runAtomically()`（D1 `batch` / better-sqlite3 `db.transaction` / MySQL 显式事务）+ `src/service/billingSettlementService.ts`；「记录 + 扣费 + 活动日志」同批提交（活动为事务外算好 JSON、事务内幂等 upsert）；扣费语句带 `record.status <> 'success'` 守卫防重复扣费；`isModuleBillingEnabled()` 事务外取；收尾失败 catch 兜底 markFailed + 可见日志。 |

---

## P1 — 功能缺陷（11 项）

| 编号 | 问题 | 位置 | 负责人 | 状态 | 修复方案 |
|---|---|---|---|---|---|
| P1-01 | **今日统计时区错位**：本地零点被 `toISOString()` 转成 UTC 作 cutoff，而 `created_at` 按本地时区存 → UTC+8 下"今日"多算 8 小时（已实测：cutoff=昨日 16:00） | `src/controller/statsController.ts:15-16,31` | 阿张 | TODO | cutoff 改用 `recordManager.formatDbDatetime`（或抽公共 util）；补 `TZ=Asia/Shanghai` 用例 |
| P1-02 | **SSE 跨 chunk CRLF 归一化污染**：整个 buffer 做 `\r\n→\n` 后 remainingBuffer 已被污染，`\r` 跨 chunk 时凭空多出事件分隔符 → 单事件被拆两个，下游 JSON 半截（已复现） | `src/util/protocolUtil/sseEventUtil.ts:16-19` | 阿张 | TODO | 只对已完成帧归一化，remainingBuffer 保留原始片段（悬挂 `\r` 留给下个 chunk）；补 chunk 边界用例 |
| P1-03 | **SSE `data:` 值被过度 trim**：整体 `.trim()`，规范只允许去掉一个前导空格 → 合法前后空格被吞，内容失真 | `src/util/protocolUtil/sseEventUtil.ts:26-29` | 阿张 | TODO | 仅 `if (value.startsWith(" ")) value = value.slice(1)`，多行 data 用 `\n` 拼接 |
| P1-04 | **流结束未 flush TextDecoder**：尾部半个多字节 UTF-8 字符丢失（中文/emoji），可能影响尾部 usage 帧 | `src/service/responseHandlerService.ts:146` | 阿张 | TODO | `result.done` 分支先 `const tail = decoder.decode(); if (tail) buffer += tail;` |
| P1-05 | **SSE 读缓冲无上限**：上游不发 `\n\n` 时 buffer 无界增长，Worker 128MB 直接 502 | `src/service/responseHandlerService.ts:93,149` | 阿张 | TODO | 设阈值（如 8MB），超限按 `sse_parse_error` 收尾并取消上游读；补用例 |
| P1-06 | **上游 200 + 空/非 JSON body 记 success 且 cost=0**：解析不出 JSON 就跳过失败判定，污染统计计费，客户端拿到 200+空体 | `src/service/responseHandlerService.ts:392,413`；`src/util/protocolUtil/upstreamFailureUtil.ts:80-83` | 阿张 | FIXED(待验) | body 为空或协议必需字段缺失 → `upstream_error`，响应原样透传，cost=0；补空/HTML/截断 JSON 三类用例 **已改**：`handleNonStreamResponse` 用 `parseJsonSafely` 区分「非 JSON 体」；空/HTML/截断 JSON → `failed_code=upstream_error`、`cost=0`、响应原样透传（HTTP 状态不变）；detail 记 `reason=empty_body|non_json_body`。 |
| P1-07 | **OpenAI→Anthropic 缺省注入 `max_tokens=32768`**：客户端不传（合法）时超 haiku 等模型上限 → 上游 400，且 4xx 不触发 failover | `src/util/protocolConverter/OpenAIToAnthropicConverter.ts:128` | 阿张 | TODO | 按 `vendor_model.max_output_tokens` 钳制，缺省取安全值（如 4096）；补"未传 max_tokens"用例 |
| P1-08 | **管理端回传 vendor 明文 token 与代理配置**：`/vendor/list.json` 原样下发上游密钥，与 inspect 模式已脱敏口径不一致 | `src/controller/vendorController.ts:20` | 阿张 | TODO | 默认脱敏（`maskUtil.maskToken`、proxy 去凭据），编辑"留空=不修改"；如需明文另开高权限 reveal 接口并审计 |
| P1-09 | **updateModel 批量赋值（mass assignment）**：仅排除 `id`/`tenant_id`，其余 body 全量 `fill`，可篡改 `created_at` 等审计列 | `src/service/modelService.ts:57-58`；`src/controller/modelController.ts:58` | 阿张 | TODO | 显式字段白名单 pick，或给 `SgModel` 加 `fillable` |
| P1-10 | **选路读路径执行写操作**：`resolveAvailableCandidates` 找不到 vendorModel 时在请求链路里 `create`，高并发产生重复行/污染配置 | `src/service/routingService/core.ts:132` | 阿张 | TODO | 自动补建挪到配置写入时；请求路径只读，找不到则 fail 并给可读错误 |
| P1-11 | **sqliteDBAdapter 按 `;` 拆分不识别字符串字面量**：`DEFAULT ';'`、注释、`BEGIN...END` 会被错误切开，产生半截 SQL 或部分执行 | `src/util/db/sqliteDBAdapter.ts` | 阿张 | TODO | 多语句改用 SQLite 原生 `db.exec()`，不做手工分裂 |

---

## P2 — 质量改进 / 测试缺口（22 项）

| 编号 | 问题 | 位置 | 负责人 | 状态 | 建议 |
|---|---|---|---|---|---|
| P2-01 | `checkBalance` 是死代码，余额门禁只在 `balance < 0` 时生效，0 余额并发会一起透支 | `src/service/userService.ts:116`；`src/service/senderService.ts:359-373` | 李哥 | FIXED(待验) | 预检按最小可计费成本拦截（**已拍板：不做透支**）；删死代码或接通；补 0 余额并发用例 **已改（阿张随 P0-4 一并处理，待李哥验）**：`senderService` 预检从 `balance < 0` 改为 `balance < 最小可计费成本(MIN_DEDUCTION_UNIT)`，0 余额首请求即 400 + 记 `insufficient_balance`；不再产生透支。`checkBalance` 仍为死代码，未删（可与预检合并，留待下次清理）。 |
| P2-02 | 2xx 非 200 被记 FAILED 且不计费 | `responseHandlerService.ts:392,413` | 阿张 | TODO | 判定改为 `status >= 200 && status < 300` |
| P2-03 | 无请求体大小上限（node/桌面模式可打满内存） | `src/middleware/llmApiMiddleware.ts:79` | 阿张 | TODO | 加 `bodyLimit`（如 32MB）+ 413，补用例 |
| P2-04 | 兜底 500 把 `String(err)` 回给调用方，泄漏内部信息 | `src/routes.ts:118` | 阿张 | TODO | 非 AppError 统一回通用文案 + requestId，详情只进日志 |
| P2-05 | `anthropic-version` 被写死 `2023-06-01`，客户端高版本被静默降级 | `src/service/senderService.ts:131,168` | 阿张 | TODO | 透传客户端版本，缺省再回落 |
| P2-06 | catch 分支 `String(err)` 泄漏（多处） | `routes.ts:126`、`balanceController.ts:23,47`、`userController.ts:87`、`systemController.ts:177` | 阿张 | TODO | 同上，统一错误文案 |
| P2-07 | `AppError` 一律记 `FailedCode.UNKNOWN`，失败归因不可用 | `src/service/senderService.ts:521` | 阿张 | FIXED(待验) | 按 statusCode/类型映射（含新增 `conversion_error`）——**与 P1-06 一次改完** **已改**：新增 `FailedCode.CONVERSION_ERROR`；`AppError` 增加可选 `failedCode`，`senderService` 兜底改为 `e.failedCode ?? UNKNOWN`；请求侧/响应侧协议转换失败记 `conversion_error`。 |
| P2-08 | 租户条件模板字符串拼 SQL（当前不可注入） | `src/manager/ruleManager.ts:33`；`statsController.ts:26,31` | 阿张 | TODO | 改 `?` 参数绑定 |
| P2-09 | 选路 N+1 查询（每 upstream 串行 findById） | `src/service/routingService/core.ts:157` | 阿张 | TODO | 批量 `whereIn` 一次取回 |
| P2-10 | `recoverOrphans` 串行逐条 update | `src/manager/recordManager.ts:185` | 阿张 | TODO | 批量 UPDATE + 分页 |
| P2-11 | `recordFailedRequest` catch 内仅 console.error，失败静默 | `src/service/recordService.ts` | 阿张 | TODO | 重试或落 fallback 日志表 |
| P2-12 | 每 chunk 打 console.log（高 QPS 即瓶颈）；`createWriteStream` 未挂 error/未 await | `src/service/streamLogService.ts` | 阿张 | TODO | 采样/降级 + 正确 await |
| P2-13 | `deleteByPrefixFromLocation` 全量收 key，内存峰值高 | `src/service/objectStorageService.ts` | 阿张 | TODO | 游标式分页删除 |
| P2-14 | `_updateD1Binding` 静默吞异常，后续用旧 binding | `src/service/ormService.ts` | 阿张 | TODO | 失败即抛或强制重新 init |
| P2-15 | `fetchUpstreamModels` 无超时，错误把上游响应体拼进 AppError | `src/service/vendorService.ts` | 阿张 | TODO | `AbortSignal.timeout`，错误只回状态码 |
| P2-16 | SPA fallback 只判断 `/v1/` 前缀，实际前缀为 `/llm/v1/` → 死代码 | `src/index.ts` | 阿张 | TODO | 对齐路由表 |
| P2-17 | ESM 中使用 `require()` | `src/local.ts:190`；`src/util/db/mysqlDBAdapter.ts:19` | 阿张 | TODO | 改 `import` / `await import` |
| P2-18 | `requireAdmin`/`requireTenantAdmin` 逻辑逐行重复 | `src/middleware/authMiddleware.ts`、`tenantScopeMiddleware.ts` | 阿张 | TODO | 抽公共 `authenticate(c)` |
| P2-19 | `APP_ERROR_SYMBOL` 定义未使用，跨 realm 判定意图未落地 | `src/customError.ts` | 阿张 | TODO | 统一 `isAppError(e)` 替换 `instanceof` |
| P2-20 | `waitUntil(task())` 未挂 catch，后台 reject 静默 | `src/util/runInBackgroundUtil.ts:18` | 阿张 | FIXED(待验) | `waitUntil(task().catch(log))` + 落 activity（**与 P0-4 一起做**） **已改**：`runInBackground` 统一 `task().catch(reportBackgroundError)`（waitUntil 与本地兜底同一条路径），异常走 `getLogger().error` + `console.error`，不再产生未处理拒绝；流式收尾 catch 额外 markFailed（含 activity）保证失败可见。 |
| P2-21 | **覆盖率产物失效且无门禁**：`coverage-final.json` 仅 3/121 文件有数据（3.1%），CI 无覆盖率任务 | `coverage/`、`.github/workflows/` | 李哥 | TODO | CI 加 `backend:test:coverage` + thresholds（先 60%）；`coverage/` 进 `.gitignore` |
| P2-22 | **测试口径与用例问题**：文件数 107 vs 文档 123；worker 跳过客户端断开 6 例 + R2 1 例（真实环境无覆盖）；`ai.negative.test.ts:257` 命名与断言不符；CORS 无用例且无 Origin 时返回 `*` + credentials | `tests/`、`vitest.worker.config.ts`、`src/middleware/corsMiddleware.ts` | 李哥 | TODO | 对齐口径；Worker 打开或补等价用例；修命名；补 CORS 三场景断言 |

---

## 附 A：已确认"不是问题"（避免误报）

- 非流式响应 Content-Type 实际透传上游（`responseHandlerService.ts:328,360`）
- 余额为整数微元（`BALANCE_SCALE=1e6`）+ `quantizeAmount`，浮点噪声已处理
- root token：placeholder 视为未配置 + SHA-256 + 恒定时间比较，实现良好
- `EXCLUDED_HEADERS` 会剥离客户端 `authorization`/`x-api-key`/`cookie`，无密钥透传
- `.dev.vars` 未被 git 跟踪；日志 token 走 `maskUtil.maskToken`；inspect 模式上游头已 `sanitizeUpstreamHeaders`
- `ruleService` deny-wins 顺序正确（forbid 403 → rate_limit 429）

## 附 B：已拍板的技术决策

1. **余额口径**：预检直接拦，不做透支（按最小可计费成本判断）。
2. **Worker 客户端断开用例**：本次一并覆盖，不留裸奔。
3. **命令注入修复标准**：改用参数数组（`execFileSync`），用例断言"未进 shell"（`execSync` 零调用），而非"命令跑通"。
4. **计费原子性**：采用 `ormService.transaction()` 最小可行方案，不做两阶段状态机；`isModuleBillingEnabled()` 事务外取。
5. **失败归因**：一次改完，新增 `conversion_error`，200+空/非 JSON 记 `upstream_error` 且 cost=0。
6. **改动范围**：独立分支，不动 master，验收通过后合入。

## 附 C：修复批次建议

- **批次 1（安全与资金）**：P0-1 → P0-4 → P1-06/P2-07（归因口径）
- **批次 2（Worker 语义正确性）**：P0-2 → P0-3
- **批次 3（协议与统计正确性）**：P1-01 → P1-02 → P1-03 → P1-04 → P1-05 → P1-07
- **批次 4（数据安全与结构）**：P1-08 → P1-09 → P1-10 → P1-11
- **批次 5（工程化）**：P2-21 → P2-22，其余 P2 随手清理
