# GT AI Gateway v1.9.0-beta1 问题台账（ISSUES）

> 汇总来源：`reviews/ai-gateway-code-review-阿张.md`（代码与安全）、`reviews/ai-gateway-test-review-李哥.md`（测试与质量）、`reviews/regression-cases-p0-李哥.md`（回归用例）
> 去重后合计 **41 项：P0 × 4、P1 × 12、P2 × 25**（P1-12、P2-23～P2-25 为验收阶段新发现）
> 状态口径：`TODO` / `IN_PROGRESS` / `FIXED(待验)` / `VERIFIED` / `WONTFIX`
> 更新规则：修完由执行人改为 `FIXED(待验)`，验收通过后改为 `VERIFIED`。

---

## P0 — 严重（安全漏洞 / 数据一致性）

| 编号 | 问题 | 位置 | 负责人 | 状态 | 修复方案 |
|---|---|---|---|---|---|
| P0-1 | **命令注入**：SQL 仅转义 `"` 后拼进 `--command="..."` 交给 shell，`$()`、反引号、`;` 可执行任意命令（`dbName`、`configPath` 同样未校验） | `src/util/db/wranglerDBAdapter.ts:23,38,44` | 阿张 | VERIFIED | 改 `execFileSync("npx", [...])` 参数数组绕开 shell；超长 SQL 走临时文件 `--file`；`dbName`/`configPath` 加 `/^[\w.\-/]+$/` 白名单；顺带修"`\n`→空格"会改坏 SQL 字面量的问题 **已改（分支 `fix/p0-security-billing`）**：`execSync`→`execFileSync("npx", argv[])`（不进 shell）；>32KB SQL 走临时文件 `--file`；新增 `src/util/db/cliArgUtil.ts` 复用白名单（拒绝 `..`/非法字符），`dbMigrationService` 的合并迁移分支与 DROP 表循环一并收口（原 `execSync(cmd)` 同类注入点）；取消 `\n`→空格替换。守卫用例 `tests/unit/security/no-shell-string-exec.test.ts` 已转绿。 |
| P0-2 | **限流在 Worker 下失效**：令牌桶是 isolate 内 Map，实际 rpm ≈ 配置 × isolate 数，规则可成倍绕过 | `src/service/rateLimitService.ts:12,55`；`src/util/rule/memoryRateLimitStore.ts` | 阿张 | VERIFIED | 采用 **D1 条件原子 UPDATE**（不引 DO，免费计划零新依赖）**已改（分支 `fix/p0-worker-isolate-state`）**：新增 `resource/migrate/migrate_0033`（`rate_limit_bucket(bucket_key PK, tokens REAL, last_ms)` + `last_ms` 索引）；`src/util/rule/sqlRateLimitStore.ts` 用「INSERT … ON CONFLICT DO NOTHING 初始化 → 单条 `UPDATE … SET tokens = MIN(cap, tokens + 补液) - 1 … WHERE 余量 >= 1 RETURNING tokens` 原子扣减」，未扣到再 SELECT 读回算 Retry-After；`rateLimitService.resolveStore()` 改为 Node→内存、Worker→SQL 存储，`consume` 异步化（类型 `ConsumeResult \| Promise<ConsumeResult>`）；`dbAdapterUtil` 的 `StatementAdapter` 补参数绑定（`.bind()` / 透传 / MySQL `execute`），新增 `SqlExecutor` + `OrmSqlExecutor`（每次调用取 `ormService.dbAdapter`，D1 binding 是 per-request）。MySQL 路径不落这张表（单进程内存天然正确），DO 仅作为可选后端预留。 |
| P0-3 | **上游故障冷却失效**：30s 冷却同样是 isolate 内状态，故障上游被持续打；`cacheService` 裸 Map 无 TTL/淘汰，Node 常驻模式只增不减 | `src/service/upstreamHealthService.ts:40,65`；`src/service/cacheService.ts:1` | 阿张 | VERIFIED | 与 P0-2 同一套共享存储 **已改（分支 `fix/p0-worker-isolate-state`）**：新增 `resource/migrate/migrate_0033` 的 `upstream_health(health_key PK, failed_at)` 表；`src/util/health/sqlHealthStore.ts`（接口 + SQL 实现 upsert/list/prune/clear）；`upstreamHealthService` 改为「**本地 Map 短 TTL 缓存（同步读，供路由 `isDown`）+ 落库共享**」：`markFailure` 先本地后落库（写库失败仅 warn，不阻断 failover），`syncFromStore()` 每请求进入路由前调用、TTL 4s 内不重复读并按 DB 整表替换（N 个 isolate 也只用 1 次 D1 读/4s，压住读放大）。`cacheService` 重写为 TTL + LRU（`maxSize` 默认 1000，Map 插入序做 LRU，新增 `size()/configure()/pruneExpired()`），不再承担跨实例一致性职责。 |
| P0-4 | **计费与记录非原子**：先 `recordService.update` 写 usage+cost，再 `deductBalance`，两步独立提交；中途失败即钱账不一致且无补偿 | `src/service/responseHandlerService.ts:222/238`（流式）、`:395/414`（非流式） | 阿张 | VERIFIED | 加 `ormService.transaction()` 抽象（SQLite `execTransaction` / D1 `batch` / MySQL `beginTransaction`），记录+扣费+活动日志三步同事务；`isModuleBillingEnabled()` 在事务外取；失败 catch 后落可见日志 **已改（分支 `fix/p0-security-billing`）**：新增 `ormService.runAtomically()`（D1 `batch` / better-sqlite3 `db.transaction` / MySQL 显式事务）+ `src/service/billingSettlementService.ts`；「记录 + 扣费 + 活动日志」同批提交（活动为事务外算好 JSON、事务内幂等 upsert）；扣费语句带 `record.status <> 'success'` 守卫防重复扣费；`isModuleBillingEnabled()` 事务外取；收尾失败 catch 兜底 markFailed + 可见日志。 |

---

## P1 — 功能缺陷（11 项）

| 编号 | 问题 | 位置 | 负责人 | 状态 | 修复方案 |
|---|---|---|---|---|---|
| P1-01 | **今日统计时区错位**：本地零点被 `toISOString()` 转成 UTC 作 cutoff，而 `created_at` 按本地时区存 → UTC+8 下"今日"多算 8 小时（已实测：cutoff=昨日 16:00） | `src/controller/statsController.ts:15-16,31` | 阿张 | VERIFIED | cutoff 改用 `recordManager.formatDbDatetime`（或抽公共 util）；补 `TZ=Asia/Shanghai` 用例 **已验（李哥）**：用例 `tests/api/stats/dashboardTimezone.node.test.ts`（4 例，`TZ=Asia/Shanghai` 下绿）——昨天 20:00 不计入 / 昨天 23:59 排除 / 今天 00:01 与零点计入 / 与 `/record/latest` 口径一致。UTC 环境是天然盲区（本地零点=UTC 零点），文件头写明必须带 TZ 跑；本机就是 UTC+8，node 全量默认覆盖。 |
| P1-02 | **SSE 跨 chunk CRLF 归一化污染**：整个 buffer 做 `\r\n→\n` 后 remainingBuffer 已被污染，`\r` 跨 chunk 时凭空多出事件分隔符 → 单事件被拆两个，下游 JSON 半截（已复现） | `src/util/protocolUtil/sseEventUtil.ts:16-19` | 阿张 | VERIFIED | 只对已完成帧归一化，remainingBuffer 保留原始片段（悬挂 `\r` 留给下个 chunk）；补 chunk 边界用例 **已验（李哥）**：`tests/unit/util/protocolUtil/sseEventUtil.crossChunk.test.ts`（chunk 投喂模拟任意切分：CRLF 切在 `\r|\n` 之间、裸 `\r` 切在帧中间、逐字节投喂与一次性投喂等价）。对修前代码（b957356 版）实测红：CRLF 跨界被拆成两条事件 `[{hel},{lo}]`。 |
| P1-03 | **SSE `data:` 值被过度 trim**：整体 `.trim()`，规范只允许去掉一个前导空格 → 合法前后空格被吞，内容失真 | `src/util/protocolUtil/sseEventUtil.ts:26-29` | 阿张 | VERIFIED | 仅 `if (value.startsWith(" ")) value = value.slice(1)`，多行 data 用 `\n` 拼接 **已验（李哥）**：同文件 —— 只去一个前导空格、尾随空格保留、多行 data 按 `\n` 拼接、纯空格 data `data:  ` 不得丢。修前实测：`data:  two  spaces  ` → `two  spaces`（trim 过度）、`data:  ` → 事件被丢。 |
| P1-04 | **流结束未 flush TextDecoder**：尾部半个多字节 UTF-8 字符丢失（中文/emoji），可能影响尾部 usage 帧 | `src/service/responseHandlerService.ts:146` | 阿张 | VERIFIED | `result.done` 分支先 `const tail = decoder.decode(); if (tail) buffer += tail;` **已验（李哥）**：`tests/api/ai/stream-sse-boundary.test.ts` + mock 新路由 `/chat/completions/split-multibyte`（按**字节**切片写，三字节中文字符被切成 1+2/2+1）——客户端内容完整 `中文流式内容测试ABC`、无 U+FFFD、记录 success。口径说明：`stream:true` 本身已覆盖跨 chunk 完整字符，flush 的直接可观测面很窄，本用例钉的是「字节级切片端到端不丢字」。 |
| P1-05 | **SSE 读缓冲无上限**：上游不发 `\n\n` 时 buffer 无界增长，Worker 128MB 直接 502 | `src/service/responseHandlerService.ts:93,149` | 阿张 | VERIFIED | 设阈值（如 8MB），超限按 `sse_parse_error` 收尾并取消上游读；补用例 **已验（李哥）**：同文件 + mock 路由 `/chat/completions/no-terminator`（只写单换行、永不出现空行）。`sse_max_buffer_bytes=4096` 时窗口内（<15s）流被主动关闭、记录 `failed/sse_parse_error`、文案含「缓冲上限」。 |
| P1-06 | **上游 200 + 空/非 JSON body 记 success 且 cost=0**：解析不出 JSON 就跳过失败判定，污染统计计费，客户端拿到 200+空体 | `src/service/responseHandlerService.ts:392,413`；`src/util/protocolUtil/upstreamFailureUtil.ts:80-83` | 阿张 | VERIFIED | body 为空或协议必需字段缺失 → `upstream_error`，响应原样透传，cost=0；补空/HTML/截断 JSON 三类用例 **已改**：`handleNonStreamResponse` 用 `parseJsonSafely` 区分「非 JSON 体」；空/HTML/截断 JSON → `failed_code=upstream_error`、`cost=0`、响应原样透传（HTTP 状态不变）；detail 记 `reason=empty_body|non_json_body`。 |
| P1-07 | **OpenAI→Anthropic 缺省注入 `max_tokens=32768`**：客户端不传（合法）时超 haiku 等模型上限 → 上游 400，且 4xx 不触发 failover | `src/util/protocolConverter/OpenAIToAnthropicConverter.ts:128` | 阿张 | VERIFIED | 按 `vendor_model.max_output_tokens` 钳制，缺省取安全值（如 4096）；补"未传 max_tokens"用例 **已验（李哥）**：`tests/unit/protocolConverter/openaiToAnthropicMaxTokens.test.ts`（7 例）——未传缺省 4096（≤8192 安全档）、显式值透传、`max_completion_tokens` 生效、0/负数回落、`tool_choice` 各形态映射、`response_format` 组合不炸且不污染 messages。注：按上限钳制落在 vendor_model 层（转换器只做安全缺省），本次只钉缺省与组合口径。 |
| P1-08 | **管理端回传 vendor 明文 token 与代理配置**：`/vendor/list.json` 原样下发上游密钥，与 inspect 模式已脱敏口径不一致 | `src/controller/vendorController.ts:20` | 阿张 | FIXED(待验) | 默认脱敏（`maskUtil.maskToken`、proxy 去凭据），编辑"留空=不修改"；如需明文另开高权限 reveal 接口并审计  **已修（阿张·批次4，待验）**：`formatVendor` 统一 `maskUtil.maskToken`（只留前 4 位），`config.proxy.url` 走 `maskUrlCredentials` 把 `user:pass@` 掩成 `****@`；list / detail / by-ids / create / update 响应一律掩码。编辑语义改「留空 = 不修改」：`token` 为 `undefined` / `` / 纯空白 / 与原值掩码一致 → 保留库里真 token（`resolveUpdatedToken`），`config.proxy.url` 回传掩码时还原真 URL（`restoreMaskedProxyUrl`），避免「看一眼再保存」把凭据打成星号。用例：`tests/api/vendor/vendor.test.ts` +3 例（掩码回传不改库内真值、缺省/空值不改、代理凭据掩码且掩码回存还原）。 |
| P1-09 | **updateModel 批量赋值（mass assignment）**：仅排除 `id`/`tenant_id`，其余 body 全量 `fill`，可篡改 `created_at` 等审计列 | `src/service/modelService.ts:57-58`；`src/controller/modelController.ts:58` | 阿张 | FIXED(待验) | 显式字段白名单 pick，或给 `SgModel` 加 `fillable`  **已修（阿张·批次4，待验）**：`MODEL_UPDATABLE_FIELDS` 白名单（name / enable / prices / routing_mode / routing_config / cross_tenant），`pickUpdatableFields(inputModel.toData())` 后 `fill`，其余列（含 `id` / `tenant_id` / `created_at` / `updated_at`）静默丢弃。 |
| P1-10 | **选路读路径执行写操作**：`resolveAvailableCandidates` 找不到 vendorModel 时在请求链路里 `create`，高并发产生重复行/污染配置 | `src/service/routingService/core.ts:132` | 阿张 | FIXED(待验) | 自动补建挪到配置写入时；请求路径只读，找不到则 fail 并给可读错误  **已修（阿张·批次4，待验）**：`resolveAvailableCandidates` 去掉 `vendorModelManager.create`，请求链路变纯读；补建挪到 `routingService.ensureVendorModels()`，由 `modelService.createModel/updateModel` 在 `validateConfig` 前调用（非 LOAD_BALANCE 且上游未指定 vendor_model_id 时按模型名补建）。候选全不可用时抛 `No available upstream for model X: <逐条原因>`（503），senderService 对该前缀回填 `NO_AVAILABLE_UPSTREAM` 失败码，保持原有记录口径。 |
| P1-11 | **sqliteDBAdapter 按 `;` 拆分不识别字符串字面量**：`DEFAULT ';'`、注释、`BEGIN...END` 会被错误切开，产生半截 SQL 或部分执行 | `src/util/db/sqliteDBAdapter.ts` | 阿张 | FIXED(待验) | 多语句改用 SQLite 原生 `db.exec()`，不做手工分裂  **已修（阿张·批次4，待验）**：`exec()` 直接 `this.db.exec(sql)`，删掉按 `;` split 的「失败回退」——该回退会把 `DEFAULT ';'`、`BEGIN...END` 切成非法片段，二次报错还掩盖真实错误。 |
| P1-12 | **CORS 白名单前缀匹配绕过**：用 `origin.startsWith("http://localhost")` 判定，`http://localhost.evil.example.com`、`http://127.0.0.1.evil.com`、`http://tauri.localhost.evil.example.com` 均被当作可信源原样回显，配合 `credentials: true` 等于给攻击者可注册子域开"带凭据跨站访问"；无 Origin 时回 `*` 与 credentials 组合在规范上无效 | `src/middleware/corsMiddleware.ts:5-16` | 阿张 | VERIFIED | 改为 `new URL(origin)` 后精确比对 hostname（`localhost`/`127.0.0.1`/`tauri.localhost`），`tauri://` 按 scheme 放行，无 Origin 不回 ACAO。回归看门狗 `tests/api/gateway/cors.test.ts`（A2 组 4 条前缀绕过 + A3 纯函数口径 + A4 无 Origin），node/worker 双模式绿 |

---

## P2 — 质量改进 / 测试缺口（22 项）

| 编号 | 问题 | 位置 | 负责人 | 状态 | 建议 |
|---|---|---|---|---|---|
| P2-01 | `checkBalance` 是死代码，余额门禁只在 `balance < 0` 时生效，0 余额并发会一起透支 | `src/service/userService.ts:116`；`src/service/senderService.ts:359-373` | 李哥 | VERIFIED | 预检按最小可计费成本拦截（**已拍板：不做透支**）；删死代码或接通；补 0 余额并发用例 **已改（阿张随 P0-4 一并处理，待李哥验）**：`senderService` 预检从 `balance < 0` 改为 `balance < 最小可计费成本(MIN_DEDUCTION_UNIT)`，0 余额首请求即 400 + 记 `insufficient_balance`；不再产生透支。`checkBalance` 仍为死代码，未删（可与预检合并，留待下次清理）。 |
| P2-02 | 2xx 非 200 被记 FAILED 且不计费 | `responseHandlerService.ts:392,413` | 阿张 | FIXED(待验) | 判定改为 `status >= 200 && status < 300`  **已修（阿张·批次4，待验）**：`statusCode >= 200 && statusCode < 300` 判成功（201/202/204 不再记 FAILED，也不再把成功请求漏计费）。 |
| P2-03 | 无请求体大小上限（node/桌面模式可打满内存） | `src/middleware/llmApiMiddleware.ts:79` | 阿张 | FIXED(待验) | 加 `bodyLimit`（如 32MB）+ 413，补用例  **已修（阿张·批次4，待验）**：`MAX_LLM_BODY_BYTES = 32MB`，先按 `content-length` 快速 413，读入后再按实读长度兜底 413（`invalid_request_error`）。 |
| P2-04 | 兜底 500 把 `String(err)` 回给调用方，泄漏内部信息 | `src/routes.ts:118` | 阿张 | FIXED(待验) | 非 AppError 统一回通用文案 + requestId，详情只进日志  **已修（阿张·批次4，待验）**：未知错误只回 `{ error: "Internal server error", message: "Internal server error", request_id }`，`errorId` 同时打进 `console.error` 便于对日志；`message` 不再回落 `String(err)`。 |
| P2-05 | `anthropic-version` 被写死 `2023-06-01`，客户端高版本被静默降级 | `src/service/senderService.ts:131,168` | 阿张 | FIXED(待验) | 透传客户端版本，缺省再回落  **已修（阿张·批次4，待验）**：客户端 `anthropic-version` 透传，缺失回落 `DEFAULT_ANTHROPIC_VERSION`（`anthropicDefaults.ts`）。 |
| P2-06 | catch 分支 `String(err)` 泄漏（多处） | `routes.ts:126`、`balanceController.ts:23,47`、`userController.ts:87`、`systemController.ts:177` | 阿张 | FIXED(待验) | 同上，统一错误文案  **已修（阿张·批次4，待验）**：`routes.ts` 兜底已改通用文案（见 P2-04）；复核 `balanceController` / `userController` / `systemController` 已无 `String(err)` 残留。保留 `modelController.ts:179` 的 `e.message`——那是管理端「测试模型」接口，需 inspect 权限且本身就是给管理员看上游报错，属预期行为。 |
| P2-07 | `AppError` 一律记 `FailedCode.UNKNOWN`，失败归因不可用 | `src/service/senderService.ts:521` | 阿张 | VERIFIED | 按 statusCode/类型映射（含新增 `conversion_error`）——**与 P1-06 一次改完** **已改**：新增 `FailedCode.CONVERSION_ERROR`；`AppError` 增加可选 `failedCode`，`senderService` 兜底改为 `e.failedCode ?? UNKNOWN`；请求侧/响应侧协议转换失败记 `conversion_error`。 |
| P2-08 | 租户条件模板字符串拼 SQL（当前不可注入） | `src/manager/ruleManager.ts:33`；`statsController.ts:26,31` | 阿张 | TODO | 改 `?` 参数绑定 （批次 4 未纳入，顺延批次 5） |
| P2-09 | 选路 N+1 查询（每 upstream 串行 findById） | `src/service/routingService/core.ts:157` | 阿张 | TODO | 批量 `whereIn` 一次取回 （批次 4 未纳入，顺延批次 5） |
| P2-10 | `recoverOrphans` 串行逐条 update | `src/manager/recordManager.ts:185` | 阿张 | TODO | 批量 UPDATE + 分页 （批次 4 未纳入，顺延批次 5） |
| P2-11 | `recordFailedRequest` catch 内仅 console.error，失败静默 | `src/service/recordService.ts` | 阿张 | TODO | 重试或落 fallback 日志表 |
| P2-12 | 每 chunk 打 console.log（高 QPS 即瓶颈）；`createWriteStream` 未挂 error/未 await | `src/service/streamLogService.ts` | 阿张 | TODO | 采样/降级 + 正确 await （批次 4 未纳入，顺延批次 5） |
| P2-13 | `deleteByPrefixFromLocation` 全量收 key，内存峰值高 | `src/service/objectStorageService.ts` | 阿张 | TODO | 游标式分页删除 （批次 4 未纳入，顺延批次 5） |
| P2-14 | `_updateD1Binding` 静默吞异常，后续用旧 binding | `src/service/ormService.ts` | 阿张 | TODO | 失败即抛或强制重新 init （批次 4 未纳入，顺延批次 5） |
| P2-15 | `fetchUpstreamModels` 无超时，错误把上游响应体拼进 AppError | `src/service/vendorService.ts` | 阿张 | FIXED(待验) | `AbortSignal.timeout`，错误只回状态码  **已修（阿张·批次4，待验）**：`AbortSignal.timeout(10000)`；非 2xx 只回 `Upstream returned <status>`（不再带回上游 body），超时 → 504 `upstream timeout`，其它网络错误 → 502 `upstream unreachable`（不回底层 message，避免带出 URL/代理地址）。 |
| P2-16 | SPA fallback 只判断 `/v1/` 前缀，实际前缀为 `/llm/v1/` → 死代码 | `src/index.ts` | 阿张 | TODO | 对齐路由表 （批次 4 未纳入，顺延批次 5） |
| P2-17 | ESM 中使用 `require()` | `src/local.ts:190`；`src/util/db/mysqlDBAdapter.ts:19` | 阿张 | TODO | 改 `import` / `await import` （批次 4 未纳入，顺延批次 5） |
| P2-18 | `requireAdmin`/`requireTenantAdmin` 逻辑逐行重复 | `src/middleware/authMiddleware.ts`、`tenantScopeMiddleware.ts` | 阿张 | TODO | 抽公共 `authenticate(c)` |
| P2-19 | `APP_ERROR_SYMBOL` 定义未使用，跨 realm 判定意图未落地 | `src/customError.ts` | 阿张 | TODO | 统一 `isAppError(e)` 替换 `instanceof` （批次 4 未纳入，顺延批次 5） |
| P2-20 | `waitUntil(task())` 未挂 catch，后台 reject 静默 | `src/util/runInBackgroundUtil.ts:18` | 阿张 | VERIFIED | `waitUntil(task().catch(log))` + 落 activity（**与 P0-4 一起做**） **已改**：`runInBackground` 统一 `task().catch(reportBackgroundError)`（waitUntil 与本地兜底同一条路径），异常走 `getLogger().error` + `console.error`，不再产生未处理拒绝；流式收尾 catch 额外 markFailed（含 activity）保证失败可见。 |
| P2-21 | **覆盖率产物失效且无门禁**：`coverage-final.json` 仅 3/121 文件有数据（3.1%），CI 无覆盖率任务 | `coverage/`、`.github/workflows/test.yml`、`vitest.config.ts` | 李哥 | VERIFIED | ① CI 新增 `test-coverage` job（`npm run backend:test:coverage` + artifact 上传）；② 两个 vitest 配置加 `coverage.thresholds` 棘轮地板：node `stmts 55 / branch 50 / funcs 55 / lines 55`（实测基线 58.41/54.83/60.57/58.37），worker `50/45/50/50`；③ `backend:test:coverage` 脚本补 `TEST_MODE=node` + 显式 `--config`（原脚本跑的是默认模式，config 不明确）；④ `coverage/` 本就在 `.gitignore`（`git check-ignore` 已确认，历史产物未入库）。**目标 60% 需批次 2 补 `src/index.ts`、`src/local.ts` 等入口后再收紧** |
| P2-22 | **测试口径与用例问题**：文件数 107 vs 文档 123；worker 跳过客户端断开 6 例 + R2 1 例（真实环境无覆盖）；`ai.negative.test.ts:257` 命名与断言不符；CORS 无用例且无 Origin 时返回 `*` + credentials | `tests/`、`vitest.worker.config.ts`、`src/middleware/corsMiddleware.ts` | 李哥 | VERIFIED | ① `ai.negative.test.ts` 两处 "should return 401 when model does not exist" 改为 404（断言本就是 404）；② 新增 `tests/api/gateway/cors.test.ts`（A1 放行 5 源 / A2 拒绝 6 源含 4 条前缀绕过回归 / A3 纯函数口径 / A4 无 Origin 不回 ACAO），顺带修出 P1-12；③ node-only 用例统一 `*.node.test.ts` 命名，worker 配置 `exclude: ['**/*.node.test.ts']`；④ **worker 的 7 例跳过全部消除**（skipped 从 7 → 0）：`stream-failure` 3 例改 `it.fails` 看门狗（P2-23 运行时语义）、2 例 `upstream-timeout` 改模式化断言（两模式都必须"已收尾 + 文案可读 + 不落裸 AbortError"）、`objectStorageChain` 在 worker 改走 R2 回读（详情 API 两次回读逐字节一致）；⑤ 新增 `tests/unit/util/timeoutAbortController.test.ts`（6 例，双模式）钉死"客户端信号一断就产出 CLIENT_DISCONNECTED 标记"；⑥ 口径实测：node **114 文件 / 1293 例**、worker **86 文件 / 1078 例（0 跳过）** |
| P2-23 | **Worker 本地不传播「客户端断开」信号**：`c.req.raw.signal` 在 `wrangler dev` 下不会因客户端 abort 而中止，流式请求断开后记录会停在 `processing`（实测 8s 采样不动），最终靠空闲超时（180s）/ 孤儿扫描（10min）兜底；非流式则跑到上游超时收尾（`upstream_timeout`）。node 模式同链路正常落 `client_disconnected` | `src/service/senderService.ts:285`、`src/util/abortTimeoutUtil.ts:206-220`、`src/service/responseHandlerService.ts:117-165` | 阿张 | VERIFIED | 已做：① 新增 `stream_max_duration_ms`（默认 30min）作为流式总时长硬上限，trickle 场景已验证生效（`tests/api/ai/stream-max-duration.test.ts`）；② 明确两个阈值关系：`stream_max_duration_ms`(30min) > `orphan_recover_threshold_ms`(10min)，孤儿回收会先触发，调参时需成对考虑。**仍缺**：上限只在 chunk 边界检查，上游"发几个 chunk 后挂住"时循环阻塞在 `readChunk(idle=180s)` 里，deadline 轮不到 → 该形态未兜住（看门狗 `tests/api/ai/stream-max-duration-hang.test.ts`，当前为 `it.fails`）。建议把剩余额度传进单次读等待：`readChunk(reader, Math.min(idleTimeoutMs, streamDeadline - Date.now()))`，或对 read 做 `raceWithTimeout(remaining)`。 **已验（李哥，b5 复验）**：③ 单次读等待已按剩余额度收窄（`readChunk(reader, Math.max(1, Math.min(idleTimeoutMs, streamDeadline - Date.now())))`），并补了「deadline 到点归因按 deadline 判定」的收尾分支；看门狗 `stream-max-duration-hang.test.ts` 已由 `it.fails` 转为正式断言且在 node/worker 双模式绿（worker 侧 4.6s 完成）。④ 同时确认 `abortWith()` 先到先得守卫（P2-24）与本项配合：断开/超时只归因一次。**残留（本地 dev 环境差异，非缺陷）**：`wrangler dev` 不保证把客户端断开传播成可收尾失败，请求上下文被一并取消时 handler 里连 markFailed 都执行不到 → 该记录只能靠孤儿回收兜住；生产 CF 会传播 signal，故不做代码兜底，用例口径改为「要么直接收尾、要么必须能被回收兜住」 |
| P2-24 | **`abortWith()` 缺"先到先得"守卫，失败归因会被覆盖**：客户端断开先到后，固定超时定时器到点仍把 `tagged` 改写成 `UPSTREAM_TIMEOUT`，详情页/统计里 failed_code 可能从 `client_disconnected` 变成 `upstream_timeout` | `src/util/abortTimeoutUtil.ts:206-235` | 阿张 | VERIFIED | `abortWith()` 开头加 `if (this.controller.signal.aborted) return;`，第一个原因赢。回归用例 `tests/unit/util/timeoutAbortController.test.ts > 超时与断开竞争时，先到的一方赢（不会双写标记）`（已从 `it.fails` 转为正式断言，node/worker 双模式绿） |
| P2-25 | **共享限流存储有写放大**：`SqlRateLimitStore.consume()` 每个放行请求都先执行一条 `INSERT ... ON CONFLICT(bucket_key) DO NOTHING`（除首个请求外必然是主键冲突的无用写），再执行扣减 UPDATE；D1 上等于每次放行 2 次写 + 概率清扫写 | `src/util/rule/sqlRateLimitStore.ts:26-40` | 阿张 | VERIFIED | 改成「先 UPDATE；0 行时用 SELECT 区分『桶不存在』与『令牌不足』，桶不存在则 INSERT 后重试一次 UPDATE」，放行快路径降到 1 条写。功能正确性已有用例保障（`tests/unit/service/rateLimitStore.crossIsolate.node.test.ts` + `tests/unit/util/sharedStateStores.node.test.ts`），本项纯性能优化 **已验（李哥）**：`tests/unit/util/rule/sqlRateLimitStore.writeCount.node.test.ts`（5 例，真 better-sqlite3 + 语句分类计数包装器）——桶已存在时放行**只 1 条写且 `run()` 0 次**、连放 5 次= 5 条写、缺桶仍 INSERT 1 次并落库、令牌不足不多写、桶被删后能重初始化。 |

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

---

## 附 B：批次 1 验收记录（李哥）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | exit 0 |
| Node 全量 | `TEST_MODE=node npx vitest --run --config vitest.config.ts` | **112 文件 / 1274 用例全绿** |
| Worker 全量 | `TEST_MODE=worker npx vitest --run --config vitest.worker.config.ts` | **85 文件 / 1063 用例：1056 绿、7 跳过**（P2-22 待办） |
| 覆盖率门禁 | `npm run backend:test:coverage` | exit 0；stmts 58.41 / branch 54.83 / funcs 60.57 / lines 58.37，高于地板 55/50/55/55 |

红→绿证据（修复前用 `git worktree add /tmp/gw-red fa22f83` 独立验证过）：

- 命令注入 16/16 红 → 绿：`execSync` 零调用、`execFileSync` 收 argv 数组、>32KB 走 `--file` 且临时文件清理、7 组非法 `dbName`/`configPath` 必须抛错且不产生子进程；
- 上游 200 + 空/HTML/截断 JSON 9/9 红（`expected 'success' to be 'failed'`）→ 绿：`upstream_error` + `cost=0` + 响应体逐字节透传；
- 计费原子性 10/10 绿：重复结算只扣一次、扣费语句带幂等守卫且排在 record UPDATE 之前、批内失败整体回滚、activity 同事务；
- 看门狗 `no-shell-string-exec.test.ts` 修复前红（`wranglerDBAdapter.ts:23` + `dbMigrationService.ts:143`）→ 绿。

**踩过的坑（写给下一位）**：

1. `node` 不在默认 PATH：跑任何命令前 `export PATH=/usr/local/bin:$PATH`。
2. 端口固定（mock 9999 / gateway 9720 / socks 9996 + 查询端点 10096 / proxy 9997），同机并发跑会互相踩；且 `globalSetup` 的 teardown 会删 `test.db`，导致对方刷 `SQLITE_READONLY_DBMOVED`。跑全量前先 `lsof -nP -iTCP:9999,9720 -sTCP:LISTEN` 确认空闲并在群里报备；清端口只 kill 自己起的 PID，**不要 `pkill -f vitest`**（会杀掉对方正在跑的套件，产出假失败）。
3. Node 模式可用 `TEST_PORT` / `TEST_BASE_URL` / `TEST_UPSTREAM_MOCK_URL` / `TEST_PROXY_PORT` / `TEST_SOCKS_PORT` / `TEST_SOCKS_QUERY_PORT` / `TEST_DB_PATH` 做隔离；但**多个用例写死 `http://localhost:9999`**（`auth.test.ts`、`rootToken.test.ts`、`proxy.node.test.ts` 等），所以全量仍必须独占端口；worker 的 9720 在 `tests/config.ts` 里写死，无法隔离。
4. 依赖 `node:child_process` 的用例必须用 `*.node.test.ts` 命名（worker 配置已 exclude），否则 worker 下必红。

### 批 B 补充：Worker 模式缺口收口（李哥）

| 项 | 命令 | 结果 |
|---|---|---|
| Node 全量 | `TEST_MODE=node npx vitest --run --config vitest.config.ts` | 114 文件 / 1293 例：**1274 绿 / 19 红**；19 红全部落在阿张在写的 P0-2/P0-3 三个文件（`upstreamHealthService` / `rateLimitService` / `dbMigrationService` 的 `DROPPABLE_TABLES`），与本次改动无关 |
| Worker 全量 | `TEST_MODE=worker npx vitest --run --config vitest.worker.config.ts` | 86 文件 / 1078 例：**1059 绿 / 19 红（同上）**，**skipped 0**（原 7 例全部跑起来） |
| 类型检查 | `npx tsc --noEmit` | exit 0 |

worker 侧这 7 例原来的 `skipIf` 处理方式（不是简单删掉 skip）：

1. `stream-failure.test.ts` 客户端断开 3 例（OpenAI / Anthropic / Responses 流式）：worker 本地不传播断开信号，记录会停在 `processing`（实测 8s 采样不动）→ 改 `it.fails` 当缺陷看门狗，指向 P2-23；
2. `upstream-timeout.test.ts` 非流式断开 2 例：改成模式化断言 —— node 期望 `client_disconnected`、worker 期望 `upstream_timeout`，但**两种模式都断言"必须已收尾 + 文案可读 + 不落裸 `AbortError`"**，把"只落 processing"这个最危险的形态卡住；
3. `objectStorageChain.test.ts` R2 链路 1 例：worker 侧不能查 `storage_record` 表（对象在 R2 binding 里），改为通过详情 API 两次回读逐字节一致来证明 R2 读写链路，node 侧保留直接查表的强断言；
4. 新增 `tests/unit/util/timeoutAbortController.test.ts`（6 例，双模式）把"客户端信号一断 → `CLIENT_DISCONNECTED` 标记 + 可读文案"钉死在单元层，弥补端到端在 worker 下观测不到的空缺。

### 批次 2 验收记录（李哥）

| 项 | 命令 | 结果 |
|---|---|---|
| Node 全量 | `TEST_MODE=node npx vitest --run --config vitest.config.ts` | **115 文件 / 1309 例全绿**，exit 0 |
| Worker 全量 | `TEST_MODE=worker npx vitest --run --config vitest.worker.config.ts` | **86 文件 / 1088 例全绿**，skipped 0，exit 0 |
| 类型检查 | `npx tsc --noEmit` | exit 0 |

批次 2 新增用例：

1. **多 isolate 模拟（P0-2 核心）** `tests/unit/service/rateLimitStore.crossIsolate.node.test.ts`（6 例）
   - 模拟手法：**同一份 SQLite 文件开多个连接** = 多个 isolate 连同一个 D1（每连接一个会话）；不需要真的起两个 isolate。
   - 断言：A 打满 rpm 后 B 必须看到桶空（不翻倍）；反向再验；A/B 交替 `Promise.all` 12 次恰好放行 `capacity` 个且 `tokens` 不为负；被拒绝的请求不扣减；不同 rule key 独立；补液后两个 isolate 看到同一份剩余量。
   - 对照用例：两个互不共享的库（= 修复前每个 isolate 一份内存）实测放行 `2 × rpm`，把失效形态也钉住，避免以后有人把共享存储又改回隔离状态。
2. **cacheService LRU / TTL（P0-3 配套）** `tests/unit/service/cacheService.test.ts` 扩到 13 例：LRU 淘汰顺序、命中移尾保护、覆盖写不挤人、`configure({maxSize})` 立即收缩、容量下界 1；TTL 过期不可见、`get` 触发真正删除（`size()` 1→0）、`pruneExpired()` 计数、重新 `set` 刷新 TTL。
3. 复核阿张已覆盖的部分（SQL 方言 ON CONFLICT / 标量 MIN、MAX / RETURNING、单实例并发不超发、冷却表 upsert/filter/prune、跨 isolate 同步与 4s TTL 节流、写库失败降级为本地冷却），未发现逻辑缺陷；仅提一个性能项 P2-25（限流每次放行 2 次写）。

**新隔离技巧（省时间）**：Node 模式全量想跟别人并行跑时，用
`TEST_PORT/TEST_BASE_URL/TEST_UPSTREAM_MOCK_URL/TEST_PROXY_PORT/TEST_SOCKS_PORT/TEST_SOCKS_QUERY_PORT/TEST_DB_PATH`
挪开端口与库；但**全量仍不能真并行** —— 多个用例里写死 `http://localhost:9999`（`auth.test.ts`、`rootToken.test.ts`、`proxy.node.test.ts` 等），改端口后那些用例会假红。worker 的 9720 在 `tests/config.ts` 写死，只能独占。

### 批次 2 复验追加（李哥）：真 D1 方言 + P2-23 缺口

**1. 真 wrangler D1 方言验证** `tests/api/rule/sharedStateD1.test.ts`（6 例，worker 下约 45s）
单元用例只证明 better-sqlite3 上的语义，这里是同一批 SQL 在真实本地 D1 上再跑一遍，且**直接读库**（能区分「真的走共享存储」与「悄悄退回内存实现」）：

| 断言 | node(SQLite) | worker(真 D1) |
|---|---|---|
| 标量 `MIN(3,5)=3` / `MAX(0,-2)=0`，逐行返回不聚合 | ✅ | ✅ |
| `ON CONFLICT(health_key) DO UPDATE` 幂等 upsert（同键写两次仍 1 行，取最新值） | ✅ | ✅ |
| `UPDATE ... RETURNING` 谓词成立返回改后行（含 `MIN`/`MAX` 补液表达式） | ✅ | ✅ |
| 谓词不成立时返回 0 行（限流判定依赖此语义） | ✅ | ✅ |
| 放行后 `rate_limit_bucket` 确实有行（证明没退回内存实现） | —（node 走内存） | ✅ |
| 预置「另一 isolate 已把桶扣空」→ 请求直接 429 | —（跨 isolate 语义只在 worker 有意义） | ✅ |
| 桶被删后能重新初始化（`INSERT ON CONFLICT` 路径） | — | ✅ |

**踩坑记录**：跨 isolate 用例最初假红（200 而非 429）。原因是 D1 CLI 写种子本身要 1s+，而 rpm=50 时补液 0.83 令牌/秒，1.3s 就把令牌补回 1.1 个 → 自然放行。改为 rpm=2（30s 才补 1 个）后稳定；诊断日志可直接看到 `tokens: 0.124 / last_ms: 种子+1349ms` 自证。**写这类「预置状态 + 等一会儿再请求」的用例，必须让补液速率慢于操作延迟。**

**2. P2-23 缺口（看门狗）** `tests/api/ai/stream-max-duration-hang.test.ts`
`stream_max_duration_ms` 只在 chunk 边界检查：上游「发几个 chunk 后挂住」时循环阻塞在 `readChunk(idle=180s)`，deadline 轮不到。实测上限 800ms + 挂住上游，3s 窗口内流未结束、记录仍 `processing`。用例为 `it.fails`（3s 跑完），修好后自动转红提醒改成正式断言。建议 `readChunk(reader, Math.min(idleTimeoutMs, streamDeadline - Date.now()))`。

**3. 阈值关系备忘**：`stream_max_duration_ms` 默认 30min > `orphan_recover_threshold_ms` 默认 10min → 实际兜底顺序是「空闲超时 180s → 孤儿扫描 10min → 总时长上限 30min」，总时长上限在默认配置下**几乎不会先触发**，调参时需成对考虑。

### 批次 2 复验追加（李哥）：b4 worker 那 1 红的定性与用例加固

**现象**：b4 worker 全量唯一红 `tests/api/ai/upstream-timeout.test.ts > Client disconnect > should write readable response_data when client aborts while waiting for upstream headers`（`expected 'processing' to be 'failed'`），且同文件 `should recover stale processing records via manual scan endpoint` 连带红（`expected 2 to be 1`）。

**定性**：**不是 P2-23 的新缺陷，是用例取数方式和运行时热重载叠加的假红**。

1. 取数方式不严谨：原用例用 `requestHelper.getFinalizedRecords(token, 1)`（= 全局最新 1 条）后直接断言 `records[0]`。这条通道按 `id desc` 取全局最新，一旦前面用例有记录残留，断言对象就不是本次请求的记录；它「等到没有 processing 为止」的轮询也只看全局最新几条，判断不了「我这条」是否收尾。
2. 连带红：上面用例把一条记录留在 `processing`，下一条用例插入 1 条过期记录后调用回收接口，`recovered` 自然变 2 → 一个真问题带出两个红点，定位成本翻倍。
3. 该轮运行期间 `src/service/responseHandlerService.ts`、`src/util/abortTimeoutUtil.ts` 被改动（阿张在做 P2-23/P2-24），`wrangler dev` 热重载会打断在飞请求 → 记录停在 processing 也是预期内的运行期现象。**跑全量期间不要改 src**，与「清端口只 kill 自己的 PID」同级纪律。

**加固**（`tests/api/ai/upstream-timeout.test.ts`）：

- 新增 `waitLatestRecordSettled(token, modelId)`：按 `model_id` 精确定位本次请求的记录并轮询到收尾，杜绝串味；为此 `hangHeaders` 模型的 id 也一并捕获。
- 客户端断开改走 `expectAbortedRequestFinalized(modelId, expectedFailedCode)`，口径分两条：① 正常收尾 → 断言 failed + 失败码 + 文案可读（不落裸 `AbortError`）；② 10s 内仍在 processing（本地 dev 的断开传播缺口）→ 触发孤儿回收，必须变 `failed/recovered_orphan` 且有 `end_at`。**「永久 processing 且回收不掉」才算红**。
- 孤儿回收用例加隔离：先 `DELETE FROM record WHERE status='processing'` 清残留；再插入「2 天前」的过期记录 + 一条「3 分钟后」的对照组（不是「现在」——本文件阈值被压到 2s，而 CLI 写种子要 1s+，用 now 会让对照组自己过期，计数变 2）；回收后断言 `recovered === 1`、过期那条 `recovered_orphan`、对照那条仍 `processing`，最后清掉残渣。

**复验数字（b5，当前 worktree）**：Worker **89 文件 / 1101 例全绿，skipped 0，exit 0**；tsc exit 0。

**踩坑记录（并发）**：b5 首轮 Node 全量出现 47 文件 / 334 例红，报 `SQLITE_READONLY_DBMOVED`（155 次）+ `no such table: client_config` —— 典型「跑的时候 `test.db` 被另一轮 globalSetup 删了/重建了」。**Node 全量必须独占**，跑前在群里报备；出现这类集体红先看是不是 `READONLY_DBMOVED`，不要当成业务回归。

### 批次 3 复验（李哥）：协议与统计边界用例 + 四道门

**新增用例（5 个文件 / 27 例）**

| 项 | 文件 | 例数 | 关键断言 |
|---|---|---|---|
| P1-02/P1-03 | `tests/unit/util/protocolUtil/sseEventUtil.crossChunk.test.ts` | 9 | 任意 chunk 切分下拆帧结果不变；data 值只去一个前导空格、尾随/行首空格保留、纯空格 data 不丢 |
| P1-04/P1-05 | `tests/api/ai/stream-sse-boundary.test.ts` | 2 | 字节级切片下内容不缺字、无 U+FFFD；坏流在缓冲上限内中止并落 `sse_parse_error` |
| P1-07 | `tests/unit/protocolConverter/openaiToAnthropicMaxTokens.test.ts` | 7 | 未传 max_tokens → 4096（≤8192 安全档）、显式值透传、非法值回落、tool_choice/response_format 组合 |
| P2-25 | `tests/unit/util/rule/sqlRateLimitStore.writeCount.node.test.ts` | 5 | 快路径 1 条写且 `run()` 0 次；缺桶/令牌不足/桶被删三条降级路径都验 |
| P1-01 | `tests/api/stats/dashboardTimezone.node.test.ts` | 4 | 昨天 20:00 不计入、昨天 23:59 排除、今天 00:01 与零点计入、与 `/record/latest` 口径一致 |

**mock 侧新增路由**（`tests/helpers/mockServer.ts`）：`/chat/completions/split-multibyte`（按字节切片写，逼出跨 chunk 多字节字符）、`/chat/completions/no-terminator`（只写单换行、永不出现空行）。

**四道门（批次 3 worktree，含阿张 P1 修复）**

| 门 | 命令 | 结果 |
|---|---|---|
| Node 全量 | `TEST_MODE=node npx vitest --run --config vitest.config.ts` | **123 文件 / 1347 passed + 3 skipped (1350)，exit 0**（78s） |
| Worker 全量 | `TEST_MODE=worker npx vitest --run --config vitest.worker.config.ts` | **92 文件 / 1120 passed，skipped 0，exit 0** |
| 类型检查 | `npx tsc --noEmit` | exit 0 |
| 覆盖率 | `npm run backend:test:coverage` | exit 0，stmts **59.31** / branch **55.01** / funcs **62.31** / lines **59.24**（地板 55/50/55/55） |

**两个坑（都吃掉过一整轮）**

1. **孤儿 `tsx src/local.ts` 会拖死全量**：机器上残留 6 个 20 分钟前、PPID=1 的本地服务，持有 test.db 连接 → 全量整体变慢（3 分钟只跑 4 个文件），并出现 `upstream-timeout` 3 例「5~7s 超时」假红。判据：`ps ax -o pid,ppid,etime,command | grep "[t]sx src/local.ts"`，PPID=1 且 etime 长的一律清掉再跑。注意**别连当前正在跑的服务器一起杀**（我杀错一次，那一轮 63 文件 / 434 例全红，纯自伤）。
2. **worker 全量启动即失败 `Port 9999 is already in use`**：上一轮全局 teardown 没回收 mock server（父进程被 kill 时还会走到 teardown，但端口没释放）。跑之前 `lsof -nP -iTCP:9999,9720 -sTCP:LISTEN` 确认干净，比事后 debug 便宜。

**测试写法坑**：读流断言里 `Promise.race([reader.read(), timeout])` 超时后若丢弃在飞的 `read()`，它会继续消费后续 chunk 并丢数据 → 假红「客户端只收到 [DONE]」。必须把 pending promise 跨轮复用；客户端侧解码同样要用 `TextDecoder({stream:true})`，否则网络分片切到多字节字符时会解出 U+FFFD 假红。

### 批次 4 修复记录（阿张）：数据安全与结构（P1-08~11 + P2 清理）

分支 `fix/p1-data-safety`（基于 `origin/1.9_dev @ 2cf513a`，不动 master、不提 PR）。

| 项 | 改动要点 | 行为变更 / 风险 |
|---|---|---|
| P1-08 | `vendorController.formatVendor` 统一掩码：`token` → `maskUtil.maskToken`（前 4 位 + `*`），`config.proxy.url` → `maskUrlCredentials`（`user:pass@` → `****@`）；list / detail / by-ids / create / update **全部**走同一出口 | **接口行为变更**：常规查询接口不再回明文 token。编辑接口改「留空 = 不修改」（`undefined` / `""` / 纯空白 / 与掩码一致），代理 URL 掩码回存时还原真值。前端 `DialogEdit` 预填的是掩码，直接保存不会覆盖真 token |
| P1-09 | `MODEL_UPDATABLE_FIELDS` 白名单 + `pickUpdatableFields`，替代 `{ id, tenant_id, ...rest }` 的全量 `fill` | 传 `created_at` / `updated_at` / 其它任意列一律静默忽略（不再能篡改审计列） |
| P1-10 | `resolveAvailableCandidates` 去掉 `vendorModelManager.create`；补建移到 `routingService.ensureVendorModels()`，由 `modelService.createModel/updateModel` 在 `validateConfig` 前调用 | 请求链路零写库；候选全不可用时抛 `No available upstream for model X: <逐条原因>`，`senderService` 按前缀回填 `NO_AVAILABLE_UPSTREAM` 失败码，记录口径不变。**配置漂移时不再自动修复**，需重新保存一次模型 |
| P1-11 | `SQLiteDBAdapter.exec` 直接 `db.exec(sql)`，删掉按 `;` split 的回退 | 触发器 / `DEFAULT ';'` / 注释里的分号不再被误切 |
| P2-02 | 成功判定改 `status >= 200 && status < 300` | 201/202/204 不再记 FAILED，也不再漏计费 |
| P2-03 | `MAX_LLM_BODY_BYTES = 32MB`：先按 `content-length` 快速 413，读入后按实读长度兜底 413 | 超大 body 不再能打满内存 |
| P2-04/P2-06 | 兜底 500 只回 `{ error: "Internal server error", message: 同文案, request_id }`，`errorId` 打进日志 | 不回 `String(err)`；`modelController` 测试模型接口保留 `e.message`（管理端 inspect 用途） |
| P2-05 | 客户端 `anthropic-version` 透传，缺失回落 `DEFAULT_ANTHROPIC_VERSION` | 不再把客户端高版本静默降级 |
| P2-15 | `fetchUpstreamModels` 加 `AbortSignal.timeout(10000)`；非 2xx 只回状态码，超时 504 / 其它 502，均不带底层 message | 不再把上游响应体 / URL 拼进错误回给前端 |

**用例**：`tests/api/vendor/vendor.test.ts` 改 2 处断言（create / update token 改为掩码口径，属**行为变更**非放宽）+ 新增 3 例（掩码回传不改库内真值、缺省/空值不改 token、代理凭据掩码且掩码回存能还原）。

**四道门（`fix/p1-data-safety` 工作区，抢 `/tmp/gw-test.lock` 独占串行）**

| 门 | 命令 | 结果 |
|---|---|---|
| Node 全量 | `TEST_MODE=node npx vitest --run --config vitest.config.ts` | **123 文件 / 1350 passed + 3 skipped (1353)，exit 0**（76s） |
| Worker 全量 | `TEST_MODE=worker npx vitest --run --config vitest.worker.config.ts` | **92 文件 / 1123 passed，skipped 0，exit 0**（313s） |
| 类型检查 | `npx tsc --noEmit` | exit 0 |
| 覆盖率 | `npm run backend:test:coverage` | exit 0，stmts **58.54** / branch **54.03** / funcs **61.70** / lines **58.46**（地板 55/50/55/55 之上；较批次 3 降约 0.75pp，因新增分支尚未全被用例覆盖） |

**顺延批次 5**：P2-08（模板串 SQL → 参数绑定）、P2-09（N+1）、P2-10（recoverOrphans）、P2-12（streamLog）、P2-13（objectStorage 分页）、P2-14（`_updateD1Binding`）、P2-16（SPA fallback 死代码）、P2-17（ESM `require`）、P2-19（`APP_ERROR_SYMBOL`）——本轮不硬塞，避免把数据安全项的验证面搅浑。
