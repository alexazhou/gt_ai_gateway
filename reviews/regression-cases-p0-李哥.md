# P0 修复的回归用例设计（李哥）

对应阿张任务 #1 的两个 P0 补丁思路（命令注入、计费原子性）+ 我这边 P1-4 暴露的 `failed_code` 归因口径问题。
测试基线：`backend:test`（node，107 文件 / 1209 用例全绿）+ `backend:test:worker`（82 文件 / 1028 用例，7 跳过）。

---

## A. P0-1 命令注入回归（`src/util/db/wranglerDBAdapter.ts`）

补丁方向（阿张）：`execSync` → `execFileSync("npx", [...args])`，SQL 走临时文件 `--file`，`dbName`/`configPath` 白名单。

### A1 注入字符集不得执行（新文件 `tests/unit/util/wranglerDBAdapter.test.ts`）
用 `vi.mock("node:child_process")` 捕获调用，重点不是"跑通了"，而是"**没有进 shell**"：

| # | 输入 SQL / 参数 | 断言 |
|---|---|---|
| 1 | `SELECT '$(id)'` | `execSync` 从未被调用；`execFileSync` 的 argv 为数组且不含拼接后的整串命令 |
| 2 | 含反引号 `` `id` `` | 同上 |
| 3 | `SELECT 1; id` （分号分隔） | 同上，且 `--command`/`--file` 只承载单条语句 |
| 4 | 含 `'` 与 `"` 混合的 INSERT（用户数据） | SQL 文本与输入**逐字节相等**（不应被引号转义改写） |
| 5 | 含 `\n` 的多行 SQL | 换行被保留（现实现把 `\n` 换空格，会改坏字符串字面量） |
| 6 | 超长 SQL（> 1MB） | 走 `--file`，argv 长度可控 |

### A2 参数白名单
| # | 输入 | 断言 |
|---|---|---|
| 7 | `dbName = "../../etc/x"` | 抛错，且不产生任何子进程调用 |
| 8 | `configPath = "/tmp/x; id"` | 抛错 |
| 9 | 合法 `dbName = "gt-gateway"`、`configPath = "./wrangler.toml"` | 正常调用，argv 顺序正确 |

### A3 正常路径回归（防过度修复）
- `tests/integration/migrationMode.node.test.ts` / `dbMigrationService` 现有用例保持绿：local/remote 两种模式、迁移失败退出码透传、stdout/stderr 归集。
- 断言迁移失败时仍返回原始错误输出（便于排查），且退出码非 0 同步。

### A4 侵入面回归
- 用 `git grep "WranglerDBAdapter"` 的调用点（`dbMigrationService.ts:54,56`）断言：仍只在 CLI 迁移路径实例化；补一条"请求链路不得触达 `execSync/execFileSync`"的守卫测试（mock 后断言调用次数为 0）。

---

## B. P0-2 计费原子性回归（`finalizeStreamResult`）

补丁方向（阿张）：`ormService.transaction(fn)` 抽象 + 三步（record update / deductBalance / requestActivity append）同事务；`isModuleBillingEnabled()` 必须在事务外取。

### B1 成功原子性
| # | 场景 | 断言 |
|---|---|---|
| 1 | 流式正常结束（OpenAI/Anthropic/Responses 各一条） | record.status=success、cost>0、user.balance 精确减少 cost、activity 有 RESULT 一条 |
| 2 | 用户余额为整数微元（如 1000000）扣 1 次 | 余额为 `1000000 - cost_units`，**无浮点尾差**（沿用 `billingUtil.quantizeAmount`） |
| 3 | `billing_enabled=false` | 不扣费、cost 照常落库、record 成功（回归） |
| 4 | `user.type === "root"` | 不扣费（回归） |

### B2 失败必须整体回滚（关键）
| # | 注入点 | 断言 |
|---|---|---|
| 5 | `userManager.incrementBalance` 抛错 | record **不得为 success**（保持 processing 并被补偿，或回滚到 failed）；有 error 级日志；余额不变 |
| 6 | `requestActivityService.append` 抛错 | 同上：要么三步全成功，要么全部不留痕（不允许"扣了钱但没有记录活动"） |
| 7 | `recordService.update` 抛错 | 余额不得变化 |
| 8 | `waitUntil` 场景（Worker）：事务整体失败 | 必须 catch + logger.error（`runInBackground` 现在是静默 catch console.error，需断言可观测） |

### B3 并发与幂等
| # | 场景 | 断言 |
|---|---|---|
| 9 | 同一用户 10 个并发流式请求（mock 上游固定 usage） | 最终 `balance == 初始 - Σcost`（无丢更新；`incrementBalance` 已原子，重点验证与 record 提交的顺序） |
| 10 | 同一 record 的 `finalizeStreamResult` 被重复触发 | 只扣一次费（两阶段状态机方案必须幂等；事务方案需保证第二次不重复扣） |

### B4 余额与计费口径（与我的 P2-1 联动）
| # | 场景 | 断言 |
|---|---|---|
| 11 | `balance = 0` + 10 个并发请求 | 不允许全部放行后一起透支；要么预检拦掉，要么明确"允许一次透支"的边界并有上限 |
| 12 | `balance < 0` + 模型 `hasBilling()` | 400 + `failed_code=insufficient_balance`（回归） |

---

## C. `failed_code` 归因口径统一（我 P1-4 + 阿张"AppError 一律 UNKNOWN"）

同意阿张"一次改完，别分两次"。建议固定一版映射表（`detectUpstreamBodyFailure` / `sendRequest` catch / `handleNonStreamResponse` 三处对齐）：

| 上游/网关情形 | `failed_code` | HTTP | cost | 备注 |
|---|---|---|---|---|
| 上游 5xx | `upstream_error` | 透传上游 | 0 | 现行为，回归 |
| 上游 4xx（请求侧） | `upstream_error` | 透传上游 | 0 | 不惩罚上游健康度（已实现） |
| 网络不可达 / DNS 失败 | `upstream_unreachable` | 502 | 0 | 已实现 |
| 响应头/体阶段僵死 | `upstream_timeout` | 504 | 0 | 已实现 |
| 上游在 200 体内报错（error/status=failed） | `upstream_error` | 200（原样透传） | 0 | 已实现，回归 |
| **200 + 空 body** | `upstream_error`（新增） | 200 透传 | 0 | **我 P1-4**：当前记 success |
| **200 + 非 JSON（HTML/截断 JSON）** | `upstream_error`（新增） | 200 透传 | 0 | 同上 |
| 协议转换失败（converter 抛错） | `unknown_error` → 建议细化 `conversion_error` | 502 | 0 | 与阿张"AppError 一律 UNKNOWN"对齐点 |
| 内部未归因异常 | `unknown_error` | 500 | 0 | 兜底 |

落地用例：新增 `tests/api/ai/nonjson-upstream.test.ts`（mock 上游分别返回空 body / `<html>504</html>` / 截断 JSON 三种），三种协议各跑一遍，断言 `status=failed`、`failed_code=upstream_error`、`cost=0`、且客户端仍收到原样响应体（不擅自改状态码）。

---

## D. 排期建议

1. A1/A2（注入用例）→ 与阿张补丁同 PR，防止回归。
2. B2/B3（原子性失败注入与并发）→ 必须与事务改造同 PR，否则无法证明"钱账一致"。
3. C（映射表）→ 与 P1-4 修复同 PR；表定稿后我在 `tests/api/ai/` 补齐三类非 JSON 上游用例。
4. A3/B1 为防回归基线，可先补，再合补丁。
