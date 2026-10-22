# GT AI Gateway v1.9.0-beta2 发布说明（定稿）

> 状态：**定稿（李哥复验，批次 1~5）**｜本文件为 `v1.9.0-beta2` 发布说明：文件名由 `release-notes_1.9.0-beta1.md` 随版本号 bump 改名，内容与代码基线对应关系见下一行
> 范围：`1.9_dev` 上 `b957356..72552ac` —— 这是**产品代码变更范围**（批次 1~5 + P2-02 无 body 状态码收口 + P2-27 孤儿回收收敛；区间内 `935f56c`/`e40ecf3` 为用例、`ba007d6`/`72552ac` 为文档）。**其后 `207305b`（评审稿入库 + `.gitignore`）、`3ae4af0`（反向守卫测试 `try/finally` 加固）仅文档与测试，不含产品代码变更**；发布终验在 HEAD `3ae4af0` 上实测。台账：`reviews/ISSUES.md`
> 基线：v1.8.8-beta5（`master` 未动，`1.9_dev` 独立推进）
> 汇总：**43 项（P0 × 4 / P1 × 12 / P2 × 27）**，全部处置完毕：**42 项已修并 VERIFIED**、**1 项经复核为误报（P2-16，WONTFIX）**（P2-26 原型污染、P2-27 D1 绑定变量上限均为验收期新增）

---

## 一、安全（Security）

| 项 | 内容 |
|---|---|
| P0-1 | **命令注入**：SQL 曾拼进 `--command="..."` 交给 shell（`$()`、反引号、`;` 可执行任意命令）。改为参数数组直传 + 输入校验，不经 shell |
| P0-2 | **限流在 Worker 下失效**：令牌桶曾是 isolate 内 Map，实际 rpm ≈ 配置 × isolate 数。改为共享存储（`SqlRateLimitStore`），跨 isolate 一致 |
| P0-3 | **上游故障冷却失效**：30s 冷却同为 isolate 内状态，故障上游被持续打。改为共享 `upstream_health` 表；`cacheService` 补 TTL/淘汰 |
| P1-08 | **管理端回传上游明文凭据**：`/vendor/list.json`、`/vendor/:id` 等曾原样下发 token 与代理 URL 里的 `user:pass`。现在 `token` 只回前 4 位 + `*`，`config.proxy.url` 的 userinfo 掩成 `****@` |
| P1-09 | **模型接口批量赋值（mass assignment）**：`PUT /model/:id` 曾把请求体全量 `fill`，可篡改 `created_at`/`updated_at` 等审计列。改为字段白名单（`name`/`enable`/`prices`/`routing_mode`/`routing_config`/`cross_tenant`），其余静默忽略 |
| P1-12 | **CORS 前缀匹配绕过**：`origin.startsWith("http://localhost")` 会让 `http://localhost.evil.com` 通过。改为精确匹配 + 显式白名单 |
| P2-03 | **请求体无上限**：`c.req.text()` 无限制，超大 body 可打满内存。新增 `llm_max_body_bytes`（默认 32MB，`0` = 不限），超限 413 |
| P2-04/P2-06 | **内部错误信息泄漏**：兜底 500 曾回 `String(err)`。现在只回通用文案 + `request_id`，细节只进日志 |
| P2-15 | **上游错误拼接响应体**：`fetchUpstreamModels` 曾把上游 body 拼进错误回给前端，且无超时。改为 10s 超时 + 只回状态码 |
| P2-26 | **请求体原型链键致 500（验收期新增）**：`JSON.parse` 把 `__proto__`/`constructor` 解析成自有属性，进 ORM `fill()` 后 casts 命中原型链 → `TypeError` → 500。入口统一剔除这三个键（静默忽略，返回 200） |

## 二、正确性（Correctness）

| 项 | 内容 |
|---|---|
| P0-4 | **计费与记录非原子**：原来「写 usage/cost」与「扣余额」两次独立提交，中途失败即钱账不一致。改为同一事务提交（`billingSettlementService.settleRecord`），要么都生效要么都不留痕 |
| P1-01 | **今日统计时区错位**：本地零点被 `toISOString()` 转成 UTC 作 cutoff，UTC+8 下「今日」多算 8 小时（漏统计 0~8 点、多统计前一天 16~24 点）。统一走本地格式化 |
| P1-02 | **SSE 跨 chunk CRLF 污染**：整个 buffer 做 `\r\n→\n` 后残留 buffer 被污染，`\r` 跨 chunk 时凭空多出分隔符 → 单事件被拆成两个、下游 JSON 半截。改为只对完整帧归一化，尾部原样保留 |
| P1-03 | **SSE `data:` 过度 trim**：规范只允许去掉一个前导空格，原实现整体 `.trim()` 吞掉合法前后空格。已按规范修正，多行 data 用 `\n` 拼接 |
| P1-04 | **流结束未 flush TextDecoder**：尾部半个多字节 UTF-8 字符丢失（中文/emoji）。EOF 分支补 `decoder.decode()` |
| P1-05 | **SSE 读缓冲无上限**：上游不发空行时 buffer 无界增长，Worker 128MB 直接 502。新增 `sse_max_buffer_bytes`（默认 8MB），超限按 `sse_parse_error` 收尾并取消上游读 |
| P1-06 | **200 + 非 JSON body 记 success 且 cost=0**：解析失败被跳过，脏响应被当成功。改为按失败处理并记录归因 |
| P1-07 | **OpenAI→Anthropic 缺省 `max_tokens=32768`**：客户端不传（合法）时超小上限模型 → 上游 400 且不触发 failover。缺省改安全值 4096，显式值透传 |
| P1-10 | **选路读路径写库**：请求链路里会 `create` vendor_model，高并发产生重复行并污染配置。补建移到配置写入时（保存模型时执行），请求路径只读；配置漂移时报可读错误而不是静默修复 |
| P1-11 | **SQLite 语句按 `;` 手工拆分**：`DEFAULT ';'`、注释、`BEGIN...END` 会被切半。改为原生 `db.exec()` |
| P2-01 | **余额门禁失效**：`checkBalance` 是死代码，门禁仅在 `balance < 0` 生效，0 余额并发可一起透支 |
| P2-02 | **2xx 非 200 被记 FAILED**：201/202/204 曾被判失败且不计费。改为 `200 <= status < 300`。另：**204/205/304/1xx 这类按 HTTP 语义不能带 body 的状态码**，此前会走「空 body → 非 JSON → upstream_error」再用 `c.body("")` 构造响应，直接抛 `TypeError: Invalid response status code 204` → 客户端 500；现在在收口分支前统一拦截：204/205 记 success + cost=0，304/1xx 记 `upstream_error`，都不设 body 并摘掉 Content-Type |
| P2-05 | **`anthropic-version` 写死**：客户端高版本被静默降级。改为透传客户端值，缺失回落默认版本 |
| P2-07 | **失败归因不可用**：`AppError` 一律记 `unknown_error`。改为按 `failedCode` 归因（协议转换失败→`conversion_error` 等） |
| P2-14 | **D1 binding 更新是 no-op**：`_updateD1Binding` 走的内部路径取不到 knex client，异常被 try/catch 吞掉 → 注释宣称的「每请求更新 binding，防跨请求 I/O 报错」**从未生效**。改走 `getKnex()?.client` 后真生效，取不到即显式报错 |
| P2-16 | ~~SPA fallback `/v1/` 前缀是死代码~~ → **误报，WONTFIX**：`tests/api/frontend/frontendApi.test.ts` 明确断言 `/v1/nonexistent` 必须返回 JSON 404，该前缀是历史别名，已保留并加注释说明 |
| P2-23/P2-24 | **客户端断开信号与失败归因**：`wrangler dev` 下不传播 abort 信号；`abortWith()` 缺「先到先得」守卫导致归因被覆盖。均已修正 |

## 三、性能（Performance）

| 项 | 内容 |
|---|---|
| P2-25 | **限流写放大**：每个放行请求都先执行一条必然冲突的 `INSERT ... DO NOTHING` 再扣减（D1 上 2 次写）。改为「先 UPDATE → 0 行再区分缺桶/不足 → 缺桶才 INSERT 重试」，稳态放行 **1 条写** |
| P2-09 | **选路 N+1**：每个上游串行 `findById`（5 上游 ≈ 10+ 次往返）。改为 3 条批量查询 + 内存命中 |
| P2-10 | **孤儿记录回收串行**：逐行 update + 逐行写活动日志。改为分页（200/批）+ 批内单条批量 UPDATE + 活动并行写。**注意**：单条 `UPDATE … WHERE id IN (?,…)` 的绑定变量数受 D1 上限（100）约束，200 个 id + 3 个赋值参数 = 203 会直接 `D1_ERROR: too many SQL variables`（P2-27）；已按 87 个 id 一片分片执行（90 预算 − 3 固定参数），批量语义与幂等性不变 |
| P2-13 | **R2 前缀删除全量收 key**：原先把所有 key 收进数组再删，几十万对象会顶爆内存。改为逐页删（内存只驻留一页） |
| P2-27 | **孤儿回收在 Worker 下整体失效**：一页 200 个 id 拼成 `WHERE id IN (?,…)` = 203 个绑定变量，超 D1 单语句上限（100）→ `too many SQL variables` → 回收接口 500。分片修完后还有**第二堵墙**：活动日志逐条 `append()`，250 条 = 750 次 D1 往返，打爆 Worker 的 subrequest 配额，且**表现不是报错而是 `ECONNRESET`**。修法：记录更新按 87 个 id 分片（`BIND_BUDGET 90 − 固定参数 3`），活动写入改为「分片批量读 → 内存拼 JSON → `ON CONFLICT(record_id)` UPSERT，50 条语句一批」 |
| P2-12 | **流日志每 chunk 打日志**：高 QPS 下日志洪水 + 热路径开销（还带两次 `includes` 扫描）。改为采样（首个 + 每 200 个），并 `finishStreamLog()` 等落盘（原来不 await 会丢尾部） |

## 四、工程化与可观测性（Engineering）

| 项 | 内容 |
|---|---|
| P2-08 | **租户条件拼 SQL**：`tenant_id = ${...}` 模板串改为 `?` 参数绑定（原本靠「调用方传整数」保证安全） |
| P2-11 | **失败记录写入静默**：`recordFailedRequest` catch 内仅 `console.error`，用户被拒却查不到痕迹。改为重试一次 + `[RECORD_WRITE_FAILED]` 结构化日志（含两次错误摘要） |
| P2-17 | **ESM 中的 `require()`**：`local.ts` 改 import；`mysqlDBAdapter` 改懒加载 `await import()` + Promise 缓存池（构造函数保持同步，worker 不触发） |
| P2-18 | **鉴权逻辑重复**：`requireAdmin` / `requireTenantAdmin` 两份逐行重复的实现，抽 `authenticateAdmin(c)` 共用，避免只改一份导致口径漂移 |
| P2-19 | **`APP_ERROR_SYMBOL` 定义未使用**：跨 realm / 重复打包时 `instanceof` 会误判 4xx 为 500。统一 `isAppError(e, kind?)`（Symbol + instanceof 双路） |
| P2-20 | **`waitUntil(task())` 未挂 catch**：后台 reject 静默。已补 |
| P2-21/P2-22 | **覆盖率产物失效且无门禁**（曾只有 3/121 文件有数据）+ 测试口径不一致（跳过项、文件数）。已修产物、加覆盖率地板与口径说明 |
| 教训 | **「静默 catch」会把 no-op 伪装成已修复**：P2-14 的 `_updateD1Binding` 整段 `try/catch` 吞异常，导致「每请求更新 D1 binding」这段保护**整整一个版本都是空转**，而代码注释还写着它生效——故障转移到查询期以 `Cannot perform I/O on behalf of a different request` 出现，根因不可见。结论：**兜底 catch 只能用于「失败可降级且必须留痕」的场景**，能明确判定为致命的路径应直接抛；所有 catch 至少打一条带上下文的日志 |
| 口径 | **覆盖率低的真实原因是「API 用例跑在子进程」**：`tests/globalSetup.ts` 用 `spawn("npx tsx src/local.ts")` 起独立服务，V8 只统计测试进程内的代码，因此 `routes.ts` / `controllers` / `responseHandlerService` / `senderService` 的进程内计数长期为 **0%**（不是「入口文件缺覆盖」）。新增的进程内 `app.request()` 用例（`tests/api/inprocess/adminRoutes.test.ts`、`tests/unit/entry/spaFallback.test.ts`）把 routes → middleware → controller → service 主链路纳入统计；**60% 地板不作为本版硬门槛**，实测达标后再抬阈值，禁止硬盖入口文件凑数 |
| 新增 | **测试锁脚本** `scripts/with-test-lock.sh`（`npm run test:locked` 等别名）：原子抢锁、`trap` 释放、区分「真在跑」与「残留锁」，杜绝并行跑全量踩库造成的假红 |
| 教训 | **「worker 小样本绿」和「只在生产规模才炸」是两个不同假设，都得验**：P2-27 第一版验证时 250 条孤儿的回收在 worker 下必 `ECONNRESET`，一度以为方案不可行；实际是**测试播种方式**造成的假象 —— worker 下反复 `wrangler d1 execute` 会打断 dev server 的 SQLite 连接。把播种改成单条多值 INSERT 后同一条路径就正常了。**假绿和假红都会误导判断**：同一个实验里要把「实现有问题」与「测量方式有问题」分开验，否则会在错误的前提上下结论 |
| 教训 | **分片只解第一堵墙，规模问题往往是叠加的**：P2-27 表面是单条 SQL 绑定变量超限（`WHERE id IN (200 个 ?)` = 203 > D1 上限 100），修完分片后 250 条孤儿仍失败 —— 第二堵墙是活动日志逐条 `append()`（每条 3 次往返 → 250 条 750 次 D1 往返），直接打爆 Worker 的 subrequest 配额，而且**表现不是报错而是 `ECONNRESET`**。最终修法是活动写入批量化（分片批量读 → 内存拼 JSON → 50 条一批 UPSERT，已随本版合入）。结论：**只看「小样本能跑通」就宣布修复，等于把 1 条记录的问题挪到 250 条记录上重新暴露** |
| 教训（事后复盘补充） | **验证手段本身也要被验证 —— 凡是自称「已检查 / 已兜底 / 已覆盖」的地方，都要配一个能让它失败的实验。** 三种失败面各有一例：① **校验器漏了对象** —— `script/verify_versions.sh` 只查 8 个文件，漏了 `tauri/src-tauri/Cargo.lock`（以及三个 lockfile 的 `packages[""].version` 副本），漏改时脚本照样全绿、CI 与本地钩子也放行，而 Rust 构建会让 cargo 自动改写锁文件，最终表现为「tag 是 beta2、锁文件还是 beta1」或多出一处脏 diff（#18）；验法：**把版本号手工改错一位，确认脚本 exit 非 0，再改回确认全绿**。② **保护逻辑空转** —— P2-14 的 `_updateD1Binding` 整段 `try/catch` 吞异常，「每请求更新 D1 binding」这段保护**整整一个版本都是空转**，注释却写着它生效；验法：**给「真的生效」写正向断言（可观测副作用），或让失败路径显式抛出**，不要只写 catch。③ **兜底分支从未被触发** —— P2-27 的反向守卫用例只证「正常时活动写进去了」，等于假设 best-effort 分支永远不到达；验法：**注入让兜底真发生（删 `request_activity` 表），并让兜底自身 `try/finally` 还原**。三者同源：**没有能失败的实验，「已检查」就只是声称**。本条目为事后复盘补充，不影响第四~六节的门禁数字与口径。 |
| 新增 | **干净门流程**：验收数字必须在独立 worktree 跑（不要把他人未提交改动混进结果）；worktree 需 `node_modules` / `frontend/dist` 软链 + 先 `npx tsx script/db.ts migrate --env worker-local`（否则 worker 门会出「空库 370 红」假红） |

---

## 五、行为变更（升级须知）

1. **vendor 凭据不再回明文**：`/vendor/list.json`、`/vendor/:id`、`/vendor/batch.json`、create/update 响应里的 `token` 均为掩码（前 4 位 + `*`），代理 URL 的 `user:pass` 掩为 `****@`。
   - **编辑语义**：`token` 留空（不传 / `""` / 纯空白 / 原样回传掩码）= 不修改；代理 URL 回传掩码时会还原真值，前端「看一眼就保存」不会把凭据打成星号。
   - **前端表现**：编辑弹窗 Token 输入框显示形如 `abcd****`，属预期。
   - 需要明文凭据的场景应另开高权限 reveal 接口 + 审计，不复用查询接口。

2. **配置漂移不再被请求静默修复**：选路不再自动补建 `vendor_model`，改到「保存模型」时补建。若升级后出现 `No available upstream for model X: vendor N: model M is not configured on this vendor (re-save the model to auto-provision)`，**在管理端把该模型保存一次**即可。

3. **D1 binding 未就绪改为显式报错**：此前该检查是 no-op（静默），现在取不到 knex client 会抛 `[ormService] 无法更新 D1 binding：sutando knex client 未就绪`。这是把「不可见的跨请求 I/O 故障」提前到明确错误，若在 worker 环境看到该错误，说明 sutando/knex 内部结构变了，需要跟进版本兼容。

4. **新增/生效的配置项**（均有默认值，不配置即保持旧行为）：
   - `sse_max_buffer_bytes`（默认 8388608 = 8MB，`0` = 不限）
   - `llm_max_body_bytes`（默认 33554432 = 32MB，`0` = 不限）
   - `stream_max_duration_ms`、`orphan_recover_threshold_ms`（批次 2 起生效）

5. **2xx 判定放宽**：201/202/204 等非 200 的 2xx 现在记为 SUCCESS 并正常计费（此前记 FAILED 且不计费），失败率统计会有可见变化。

6. **新增失败码 `conversion_error`**：协议转换失败（请求侧无法转成上游格式 / 响应侧无法转成客户端格式）此前一律归 `unknown_error`，现在单独归因（P2-07）。失败码是统计与告警的过滤维度，报表里会看到这个新值。

7. **新增数据库迁移 `migrate_0033`**（P0-2 限流 / P0-3 上游冷却）：新增两张表 `rate_limit_bucket`（跨 isolate 令牌桶）、`upstream_health`（跨 isolate 上游冷却标记）。**升级必须执行迁移**，否则 Worker 下限流与冷却会因缺表报错（此前这两个状态只在 isolate 内存里，天生不共享）。MySQL 路径同样建表保持 schema 一致，但限流仍走进程内实现（单进程天然正确）。


---

## 六、验证

### 四道门（@ `1.9_dev` HEAD `3ae4af0` = 批次 1~5 + P2-02 + P2-27 + 用例加固全部合入后，独立 worktree `git status` 干净、端口与测试锁独占）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | exit 0 |
| Node 全量 | `npm run test:locked` | **140 文件 / 1459 passed + 3 skipped (1462)**，exit 0（批次5 新增 10 个用例文件 / 65 例；+2 条 205/304 无 body 用例；+1 条 P2-27 反向守卫） |
| Worker 全量 | `npm run test:locked:worker` | **107 文件 / 1219 passed，skipped 0**，exit 0（P2-27 修好后最后一个 skip 也打开了） |
| 覆盖率 | `npm run test:locked:coverage` | stmts **64.71** / branch **57.08** / funcs **67.51** / lines **64.93**，地板 **60/52/60/60**，exit 0（较上轮低约 0.5pp：P2-27 新增 185 行批量化代码，分支未全覆盖，属预期） |

> 覆盖率提升不是靠补入口文件：新增的两个**进程内**用例（`tests/api/inprocess/adminRoutes.test.ts` 打 14 条只读管理端链路、`tests/unit/entry/spaFallback.test.ts` 驱动 index.ts 的 fallback）让 routes/controllers/middleware 的进程内计数从 0% 起来，lines 57.84% → 65.53%。

> Worker 门的唯一 red 已闭环：`tests/api/gateway/p2-cleanup.test.ts`「Content-Length 超过 32MB 时直接 413」用手工伪造 `Content-Length` + 少量字节，node 侧读 header 即 413（7/7 全绿），但 workerd/miniflare 会在进 Worker 前等满声明长度 → 60s 超时，属运行层差异而非实现缺陷。已由 `8063a3f` 按运行模式分流（worker 跳过该条，实读长度兜底由 `llm_max_body_bytes` 分支覆盖）。

> 另注：worker 全量首跑出现过一次 `ECONNRESET`（`tests/api/vendor/vendorMask.test.ts` 的 `createVendor`，workerd 连接被重置）；该文件单跑 8/8 绿、全量二跑 96 文件全绿，判定为 workerd 本地 dev server 偶发抖动，非实现问题。

### 关键回归用例（新增，均标注「修前红 / 修后绿」）

- SSE 跨 chunk：任意切分等价性（CRLF 切在 `\r|\n` 之间、裸 `\r` 切在帧中间、逐字节 vs 一次性）
- SSE 边界：字节级切片不丢中文、缓冲上限触发 `sse_parse_error`
- 统计时区：`TZ=Asia/Shanghai` 下今日边界
- 限流写放大：真 sqlite + 语句计数（快路径 1 条写、`run()` 0 次）
- vendor 掩码：掩码回传后直查库确认 token 未变、代理凭据掩码与回存还原
- 模型白名单：`created_at`/`updated_at` 传了也不生效
- 选路读路径无写：删掉 vendor_model 模拟漂移 → 503 + 可读文案 + 行数仍 0
- 孤儿回收：250 条孤儿（跨 2 页）+ worker 下全量回收 + 活动逐条落库 + 重复调用幂等（P2-27，修前 worker 500 / ECONNRESET）；**反向守卫**：删表注入活动写入失败 → 回收接口仍 200、记录照样回收、`app.log` 留下 warn（best-effort 语义，且不是静默 catch）
- 无 body 状态码：上游 204/205 → 客户端原样 204/205 + 记录 success + cost=0；上游 304 → 客户端 304 + 记录 `upstream_error` + cost=0（修前三条全 500）

---

## 七、已知限制 / 遗留

- **P2-16 → WONTFIX（误报）**：`/v1/` 前缀是历史别名，有测试断言其返回 JSON 404，保留。
- **已知抖动（非缺陷）**：worker 全量首跑偶发过 `ECONNRESET`（`tests/api/vendor/vendorMask.test.ts` 的 `createVendor`，workerd 本地 dev server 连接被重置）。同一文件单跑 8/8 绿、全量二跑 96 文件全绿，判定为 wrangler dev 前置层的偶发抖动，不影响产品行为；CI 上遇到该文件单独报 `fetch failed` 时重跑即可。
- 覆盖率地板已抬到 60/52/60/60（`vitest.config.ts`），本版实测 64.71 / 57.08 / 67.51 / 64.93。**注意分母口径**：API 用例跑在子进程里，进程内计数为 0%（见「工程化」末条），所以 57~58 主要是单元层的真实水位；把地板抬到 60 的路线是补进程内 `app.request()` 主干用例，而不是给 `src/index.ts` / `local.ts` 硬盖测试。
- `modelController` 的「测试模型」接口仍会把上游错误 message 回给管理员（inspect 用途，需管理权限），属预期。
- **P2-27 已闭环（验收期由批次5 用例发现）**：`recordManager.recoverOrphans` 按 200/批拼 `UPDATE ... WHERE id IN (?,?,...)`，3 个赋值参数 + 200 个 id = **203 个绑定变量**，超 D1 单语句上限 → `D1_ERROR: too many SQL variables` → `POST /record/recover-orphans.json` **在 worker 环境返回 500，孤儿回收整体失效**（node/sqlite 上限 999，故此前一直未暴露）。修法：抽 `RECOVER_ORPHAN_BIND_BUDGET = 90`（上限 100 留 10 余量）+ 3 个固定参数 → 每片 87 个 id，分片执行同一批 UPDATE；分页 200 与「一条 SQL 带几个 id」是两件事，分页保留。**已修（`a219309`，阿张分支上的原始 commit 为 `704be9b`）并复验**：`recoverOrphans.batch.test.ts` 的 `it.fails`/`it.skipIf` 已全部转正式断言，worker 下 250 条孤儿（跨 2 页）接口 200、`recovered ≥ 250`、`processing` 残留 0、`end_at` 全落、活动日志逐条落库且不重复；外加一条**反向守卫**（删 `request_activity` 表注入活动写入失败 → 回收仍 200、记录照样回收、日志留 warn）；worker 门 skipped 归零。
- **P2-02 已闭环（原「204 → 500」不再存在）**：`isBodyForbiddenStatus()`（204/205/304/1xx）在 `!ok` 与「非 JSON body」两个分支之前统一收口，204/205 记 `success` + `cost=0`，304/1xx 记 `upstream_error`，一律不设 body 并摘掉 `Content-Type`；`senderService.isStream` 增加 `upstreamRes.body !== null` 防「204 + `text/event-stream`」在 `getReader()` 上二次抛错。回归用例：204/205/304 三条（`p2-cleanup.test.ts`），mock 上游新增 `status-205` / `status-304`。

---

## 八、升级步骤

1. 备份数据库。本版**有新增表**（`migrate_0033`：`rate_limit_bucket` / `upstream_health`），无破坏性 schema 变更。
2. 升级后执行迁移：`npm run db:migrate:node`（或对应 worker 环境的 `db:migrate:worker-cloud`）。**Worker 环境漏跑迁移会导致限流与上游冷却因缺表报错**。
3. 检查配置：如需自定义上限，设置 `sse_max_buffer_bytes` / `llm_max_body_bytes`（不设置即用默认值）。
4. **管理端自检**：打开 vendor 列表确认 Token 显示为掩码；如某个模型报 `No available upstream ... (re-save the model to auto-provision)`，保存该模型一次。
5. 检查失败率指标是否有台阶变化（2xx 判定放宽后 201/204 不再计为失败）。
