# GT AI Gateway v1.9.0-beta1 代码与安全审查（阿张 / 研发部）

审查范围：`/Volumes/PDATA/GitDB/serverless_ai_gateway`（Cloudflare Workers + Hono + TypeScript）
结论：P0 × 4、P1 × 9、P2 × 15，共 28 项。
整体评价：架构分层清晰（routes → controller → service → manager/model），鉴权与余额实现质量高（恒定时间比较、整数微元、root placeholder 防误用），协议转换不静默丢弃内容。主要风险集中在 **Worker 多 isolate 语义下失效的进程内状态（限流 / 上游冷却）**、**本机 CLI 适配器的命令注入**、**计费与记录非原子**。

---

## P0（严重 Bug / 安全漏洞）

### P0-1 `wranglerDBAdapter` 命令注入
- 位置：`src/util/db/wranglerDBAdapter.ts:23`（`execSync`）、`:38`、`:44`
- 现状：SQL 只做 `sql.replace(/"/g, '\\"')` 后拼进 `--command="..."`，再交给 shell。
- 影响：SQL 中出现 `$(...)`、反引号、`;`、`\` 时会被 shell 解释，构成命令注入（例如迁移文件或 `--sql` 参数内容即可执行任意命令）。`configPath`、`dbName` 同样未转义。
- 建议：改用 `execFileSync("npx", ["wrangler", "d1", "execute", dbName, "--config", configPath, "--command", sql])` 参数数组形式，彻底绕开 shell；至少要对 `$`、反引号、`\`、换行做转义并把 SQL 走临时文件/stdin。

### P0-2 限流在 Worker 下失效（多 isolate 各算一份）
- 位置：`src/service/rateLimitService.ts:12`（`let store = memoryRateLimitStore`）、`:55`（`store.consume`）；`src/util/rule/memoryRateLimitStore.ts`
- 现状：令牌桶是进程内 Map，注释也写明"Node 单进程内同步读写天然原子"。Worker 每个 isolate 一份，请求分散到 N 个 isolate 后实际 rpm ≈ rpm × N。
- 影响：租户配置的 `rate_limit` 规则可被成倍绕过，等于限流形同虚设；计费/资源保护失效。
- 建议：Worker 模式改用 Durable Object（每 rule 一个 DO 做原子令牌桶）或 D1/KV + 单条带条件的原子 UPDATE（`UPDATE rate_limit SET tokens=... WHERE ... AND tokens>=1`）；`setStore()` 已预留接口，按 `ormService.mode` 注入实现即可。

### P0-3 上游故障冷却在 Worker 下失效
- 位置：`src/service/upstreamHealthService.ts:40,65`；底层 `src/service/cacheService.ts:1`（裸 `new Map()`）
- 影响：`UPSTREAM_FAILURE_COOLDOWN_MS = 30s` 的跨请求隔离只在单 isolate 内有效，故障上游会被持续打到；同时 Map 无 TTL/容量淘汰，Node 常驻（desktop）模式下只增不减。
- 建议：与 P0-2 同一套共享存储（DO 或 KV，KV 需接受最终一致）；`cacheService` 增加 `maxSize` + LRU/TTL 清扫。

### P0-4 计费与记录非原子
- 位置：`src/service/responseHandlerService.ts:222/238`（流式）、`:395/414`（非流式）
- 现状：先 `recordService.update(...)` 写 usage+cost，再 `userService.deductBalance(user.id, cost)`，两步独立提交。
- 影响：任一中间失败（DB 抖动、`waitUntil` 被切断）会出现"记录成功但未扣费"或"扣费但记录未更新"，钱账不一致且无补偿；流式路径的两处都在后台任务中，可观测性更差。
- 建议：同一事务内完成（D1 batch / SQLite `execTransaction`），或改为"余额先扣、记录失败则回滚"并加一张对账流水表；退一步至少记录一条 `billing_pending` 供后台补偿任务扫描。

---

## P1（功能缺陷）

### P1-1 今日统计时区错位
- 位置：`src/controller/statsController.ts:15-16,31`
- 现状：`today.setHours(0,0,0,0)` 取本地零点，随后 `toISOString()` 转成 **UTC** 字符串作为 cutoff；而 `record.created_at` 按本地时区 `YYYY-MM-DD HH:mm:ss` 存储（`recordManager.formatDbDatetime:173`）。
- 影响：UTC+8 环境下 cutoff 变成"昨日 16:00"，今日请求数/成功率虚高 8 小时数据。
- 建议：复用 `recordManager.formatDbDatetime(new Date(...))`，或统一改为 UTC 存储并在查询侧换算。

### P1-2 SSE 解析缓冲区无上限
- 位置：`src/service/responseHandlerService.ts:149`（`buffer += chunk`）
- 影响：上游持续输出但始终不发 `\n\n`（或分隔符异常）时 buffer 无界增长，Worker 128MB 内存被打爆 → isolate 崩溃、请求全部失败。
- 建议：设置上限（如 4MB / 单事件 1MB），超限按 `SSE_PARSE_ERROR` 终止并 markFailed。

### P1-3 流结束未 flush TextDecoder
- 位置：`src/service/responseHandlerService.ts:146`（`decoder.decode(chunk, {stream:true})`），EOF 分支未调用 `decoder.decode()`
- 影响：上游最后一个 chunk 若以半个多字节 UTF-8 字符结尾，尾部字符丢失（中文/emoji 场景），可能连带影响尾部 usage 帧。
- 建议：`result.done` 分支先 `const tail = decoder.decode(); if (tail) buffer += tail;` 再走 splitEvents。

### P1-4 SSE `data:` 值被过度 trim
- 位置：`src/util/protocolUtil/sseEventUtil.ts:26-29`
- 现状：`data:` 之后整体 `.trim()`。SSE 规范只允许去掉**一个**前导空格。
- 影响：数据中合法的前后空格被吞掉（代码块缩进、JSON 前后空白语义、prompt 内容），造成协议内容失真。
- 建议：仅 `if (value.startsWith(" ")) value = value.slice(1);`，多行 data 用 `\n` 拼接。

### P1-5 归一化破坏剩余缓冲区边界
- 位置：`src/util/protocolUtil/sseEventUtil.ts:16-19`
- 现状：`\r\n|\r` → `\n` 的归一化作用在整个缓冲上，`remainingBuffer` 保存的是归一化后的分片。
- 影响：chunk 边界正好切在 `\r\n` 中间时（尾部仅剩 `\r`），被转成 `\n`，下一次拼接成 `\n\n` 会**凭空多出一个事件分隔符**，产生空事件/错帧。
- 建议：只对已完整切分出的部分做归一化，剩余缓冲保留原始字节；或改用"按行读 + 状态机"实现。

### P1-6 `updateModel` 存在批量赋值（mass assignment）
- 位置：`src/service/modelService.ts:57-58`（`const {...} = inputModel.toData(); model.fill(updateData)`）；入口 `src/controller/modelController.ts:58`（`new SgModel(body)` 直接吃整个 body）
- 现状：只排除了 `id`、`tenant_id`，其余 body 字段全部 `fill` 到模型上。
- 影响：客户端可写入任意列（如 `created_at`/`updated_at` 篡改审计时间；若后续加列则更危险）。虽然 `cross_tenant` 会被重新归一 + `assertModelScope` 兜底，但白名单缺失是结构性风险。
- 建议：显式列白名单 pick（name/enable/prices/routing_config/...），或给 `SgModel` 加 `fillable`。

### P1-7 vendor token 明文返回前端
- 位置：`src/controller/vendorController.ts:20`（`token: vendor.token`）
- 影响：列表/详情接口把上游密钥原样下发；一旦前端日志、截图、XSS 或低权限管理员账号泄漏即等于密钥泄漏。
- 建议：默认脱敏（`maskUtil.maskToken`），编辑时"留空即不修改"，需要时提供独立的高权限 reveal 接口并记审计。

### P1-8 选路读路径中执行写操作
- 位置：`src/service/routingService/core.ts:132`（`vendorModelManager.create(...)`）
- 影响：`resolveAvailableCandidates` 在非 LOAD_BALANCE 模式下找不到 vendorModel 时会**主动创建**记录 —— 请求路径带写操作，高并发下会产生重复行/唯一键冲突，且读接口异常时污染配置数据。
- 建议：把自动补建挪到配置写入时（创建/更新 model、vendor 时），请求路径只读；找不到则 fail 并给出可读错误。

### P1-9 `sqliteDBAdapter.exec` 按 `;` 拆分不识别字符串字面量
- 位置：`src/util/db/sqliteDBAdapter.ts`（整体执行失败后按 `;` 拆分重试）
- 影响：迁移/DDL 中出现 `DEFAULT ';'`、注释、`BEGIN...END` 触发器时会被错误切开，产生半截 SQL 报错或部分执行（状态不一致）。
- 建议：正常路径用单条执行；需要多语句时用 `db.exec()`（SQLite 原生支持多语句）而不是手工分裂。

---

## P2（质量改进）

1. `src/routes.ts:126`、`balanceController.ts:23,47`、`userController.ts:87`、`systemController.ts:177`：catch/兜底分支把 `String(err)` 直接返回给客户端，泄漏内部实现细节。建议统一返回通用文案 + requestId，详情只进日志。
2. `src/service/senderService.ts:521`：`AppError` 分支一律 `FailedCode.UNKNOWN`（message 固定"请求处理失败"）。建议按 `statusCode`/错误类型映射到 `PROTOCOL_CONVERT_ERROR`、`NO_AVAILABLE_UPSTREAM` 等，否则失败归因不可用。
3. `src/manager/ruleManager.ts:33`、`src/controller/statsController.ts:26,31`：租户条件用模板字符串拼 SQL（虽经 `Number()` 或 parseInt，当前不可注入）。建议改成 `?` 参数绑定，避免后续改动引入真实注入。
4. `src/service/routingService/core.ts:157` 附近：`resolveAvailableCandidates` 对每个 upstream 串行 `findById`（vendor + vendorModel），典型 N+1。建议批量 `whereIn` 一次取回（SgModel 的实例数 × 上游数直接决定耗时）。
5. `src/manager/recordManager.ts:185` 附近 `recoverOrphans`：串行 for 循环逐条 update + 追加活动，孤儿多时极慢。建议单条批量 UPDATE + 分页处理。
6. `src/service/recordService.ts` `recordFailedRequest`：catch 内仅 `console.error`，失败静默。建议重试或落 fallback 日志表，否则"缺记录"无法发现。
7. `src/service/streamLogService.ts`：`appendStreamLog` 每 chunk 打一次 `console.log`（高 QPS 下日志即瓶颈）；`writeRequestLog` 的 `createWriteStream` 未挂 `error` 监听也未 await `finish`。建议采样/降级 + 正确 await。
8. `src/service/objectStorageService.ts` `deleteByPrefixFromLocation`：先把所有 key 收进数组再批量删，对象多时内存峰值高。建议游标式分页删除。
9. `src/service/ormService.ts` `_updateD1Binding`：`try/catch` 静默吞异常，失败后后续请求会用旧/错 binding。建议失败即抛或降级到强制重新 init。
10. `src/service/vendorService.ts` `fetchUpstreamModels`：`fetch` 无超时（可能一直挂），错误时把上游响应体拼进 `AppError` 回传前端。建议加 `AbortSignal.timeout`，错误只回状态码。
11. `src/index.ts` SPA fallback：只判断 `/v1/` 前缀，但实际 API 前缀是 `/llm/v1/`，`/v1/*` 并不存在 → 该分支是死代码，而真正需要 404(@json) 的路径依赖 `.json` 后缀兜底。建议对齐路由表。
12. `src/local.ts:190`：ESM 里 `require('fs').writeSync(...)`（另有 `mysqlDBAdapter.ts:19` 的 `require`），依赖 `createRequire` 或打包器转换，某些 Node 版本/`"type":"module"` 下会直接失败。建议改成 `import { writeSync } from "node:fs"` / 动态 `await import`。
13. `src/middleware/authMiddleware.ts` 与 `src/middleware/tenantScopeMiddleware.ts`：`requireAdmin` / `requireTenantAdmin` 的 token→user→status 校验逻辑几乎逐行重复。建议抽公共 `authenticate(c)`，降低两处走偏的风险（安全代码尤其怕复制）。
14. `src/customError.ts`：`APP_ERROR_SYMBOL` 定义后未被任何 `instanceof`/判定使用（跨 realm 判定的意图没落地）。建议统一判定函数 `isAppError(e)` 并替换各处 `instanceof`。
15. `src/util/runInBackgroundUtil.ts:18`：`waitUntil(task())` 未挂 catch，后台任务 reject 时在 Worker 里表现为未处理拒绝。建议 `waitUntil(task().catch(log))`。

---

## 附：已确认"不是问题"的点（避免误报）

- 非流式响应 Content-Type 没有硬编码：`responseHandlerService.ts:328,360` 均使用上游 `content-type` 并带 `application/json` 兜底。
- 余额为整数微元（`BALANCE_SCALE=1e6`）+ `quantizeAmount` 取整到最小扣减单位，浮点噪声已处理。
- root token 安全性 OK：`userService.isRootTokenConfigured` 把空值/`PLACEHOLDER_ROOT_TOKEN` 视为未配置；token 比较走 SHA-256 + `constantTimeEqualBytes`。
- `EXCLUDED_HEADERS` 会剥离 `authorization`/`x-api-key`/`cookie`，上游鉴权由网关覆盖，未发现客户端密钥透传到上游。
- `ruleService` deny-wins 顺序正确（先 forbid_access 403，再 rate_limit 429），`root` 旁路符合预期。
