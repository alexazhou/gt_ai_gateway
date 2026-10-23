# T7：本地 MySQL 门（`npm run test:mysql`）

> 状态：**已建门**（首跑出生证明见 §5）。任务单 `#25`。
> 归属：**加法**——不改任何既有门（`backend:test` / `backend:test:worker` / 覆盖率）的语义与用例集。

## 1. 为什么这条门必须存在（给「将来想删掉它的人」看的）

| 事实 | 数据 |
|---|---|
| 本地 sqlite 全量门 | 140 文件 / 1459 passed + 3 skipped，**全绿** |
| worker 门（D1 / sqlite 方言） | 107 文件 / 1219 passed，**全绿** |
| CI MySQL 门 | 27 文件 / 91 例失败，**连红 10/10 个 run** |
| 同一份代码 | 同一 commit，同一夜间 |

**根因不在覆盖率**：`usage` 在 SQLite 里可以裸用（能解析、能执行、不报错），只有 MySQL 把它当保留字（`GRANT USAGE`）。→ **任何 MySQL-only 的语法/语义缺陷，本地 sqlite 门永远绿，加用例、抬覆盖率都补不上**，因为缺陷在本地**物理上不可见**。

「CI 已经有一条 MySQL job」不能替代这条门，两者互补且各有致命缺陷：

| | CI MySQL job | 本地 `test:mysql` |
|---|---|---|
| 反馈延迟 | 一轮 push + 8~10 分钟，还要排队 | 秒级～分钟级 |
| 失败可见性 | **红着也会被忽略**（#22 的 10 连红就是证据——新错被埋进常态红） | 本地红会挡住提交 |
| 能否防「新增回归」 | 不能（常态红 → 新红不可见） | 能（**绿是新常态才有对照价值**） |

## 2. 用法

```bash
# 1) 起 MySQL（参数与 CI 的 services.mysql 逐项一致：root/rootpass + DB=test + 3306）
docker compose -f docker-compose.test-mysql.yml up -d
#    等健康检查通过（mysqladmin ping），约 10s

# 2) 跑门（自带测试锁，抢不到锁就退出，绝不「没抢到还继续跑」）
npm run test:locked:mysql

# 3) 收工
docker compose -f docker-compose.test-mysql.yml down -v
```

`test:mysql` = **前置检查**（`script/check-mysql-gate.ts`）+ `DB_DRIVER=mysql` 跑 `vitest.mysql.config.ts`（与 sqlite 门同一套用例，只换方言）。

`DB_*` 全部复用 `tests/config.ts:52-58` 已有的变量，**不新增配置项**；缺省值与 compose 一致（`127.0.0.1:3306 / root / rootpass / test`），需要覆盖时直接给环境变量。

## 3. 硬要求（已裁定，不得自行放宽）

1. **禁止「连不上就静默回退 sqlite」**：`DB_DRIVER=mysql` 但 3306 不通 → 门**直接 exit 1**，打印脱敏连接串 + `DB_DRIVER` + 引擎探测结果 + 起容器命令。否则「忘了起容器」会得到一条与 #22 一模一样的假绿。
2. **方言心跳两条互为反证**（`tests/unit/db/mysqlGateHeartbeat.mysql.test.ts`）：
   - `SELECT version()` 必须**成功**（连对引擎）；
   - `SELECT sqlite_version()` 必须**抛错**（连错引擎时它必然成功 → 报警）。
   - **`@@version` 方案禁用**：它在 SQLite 报 `unrecognized token: "@"`，是**语法错**不是**引擎错**，会与「SQL 写错」混淆。
3. **报错文案**必须包含：脱敏连接串（`mysql://root:***@127.0.0.1:3306/test`）、`DB_DRIVER`、引擎探测结果、起容器命令。
4. **出生证明四要素**：被测代码 sha + 门自身 sha + 取数时刻 + 日志路径（日志**不得只放 `/tmp`**）。
5. **删除条件写死**：CI 的 MySQL job **连续 20 个 run 全绿**之后才可讨论降级；且必须承认「本地门管新红可见、CI 管合入前把关」，**不可互相替代**。

## 4. 为什么先建门、再修 #22（顺序不能反）

先修 `#22` 再建门 → **永久拿不到出生证明**，只剩两条人手贴的日志（「人手贴的证据」最容易被后来的自己相信）。先建门 → 「红 → 绿」是**门自己产出的证据链**，谁都不用自证。代价是门会先红一段时间（看着像「把门弄坏了」），所以出生证明必须留两处：commit message + `#22.result` 里贴同一份红日志原文（带取数时刻与 run id）。

## 5. 出生证明（首跑必红）

**四要素（缺一不可 —— 门代码也会演进，只写一个 sha 无法复现「当时那个门跑当时那个代码」）**

| 要素 | 值 |
|---|---|
| 被测代码 sha | **`7f4fba2`**（`usage` 仍裸 = 修复前状态） |
| **门自身 sha** | **`1613d5a`** |
| 取数时刻 | **2026-10-23T08:34:06+0800** |
| 日志路径 | `/Volumes/PDATA/GitDB/beta2-record-backup/t7-birth-red.log`（7618 行，sha256 `6dd30f951c8b…`，**持久位，不在 `/tmp`**） |
| worktree / 容器 | `/Volumes/PDATA/GitDB/sag-t7` / `mysql:8`（8.4.11，healthy） |

**结果：红（预期）**

```
Test Files  27 failed | 114 passed (141)
     Tests  91 failed | 1362 passed | 12 skipped (1465)
gate_exit=1
```

- 红在 **`near 'usage = ? WHERE id = ?' at line 1`**，全日志出现 **24 次**（`ER_PARSE_ERROR` / errno 1064）
- 心跳 3 例全过：`[mysql-gate] 引擎探测成功：8.4.11`
- **与 CI 的 MySQL job 逐位一致**：CI `27 failed / 113 passed (140)`、`91 failed / 1359 passed / 12 skipped (1462)`；本地唯一增量就是新增的心跳文件（+1 文件 / +3 例，全过）。失败文件清单双向 `comm` 差集**均为空**。

**既有门不受影响（实测，不是推理）**：同一分支上跑 `npm run backend:test`（sqlite 全量门）→
`Test Files 140 passed (140)` / `Tests 1459 passed | 3 skipped (1462)` / `exit 0`，
与建门前基线**逐位相同**（新增的 `*.mysql.test.ts` 被基础配置排除，只在 MySQL 门里收集）。
日志：`/Volumes/PDATA/GitDB/beta2-record-backup/t7-sqlite-gate-unaffected.log`（取数时刻 2026-10-23T08:37:13+0800）。

**提交结构**：`7f4fba2` → **`1613d5a`（门本体，出生证明对应的就是它）** → `74839c1`（本文档）。
之所以把文档单列一个 commit 而不是 amend 进门里：**amend 会改写 sha，出生证明里的「门自身 sha」就再也对不上任何真实提交** —— 证据链优先于提交整洁。

### 5.1 建门过程：4 次首跑，前 3 次都被「门自身的缺陷」拦下

这段保留是因为它证明了一件事：**门也需要被证据验证**（R5）。三次都不是产品问题，都是门自己写错：

| 跑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `[FATAL] DB_DRIVER=sqlite`，门把自己拦住了 | `package.json` 里 `cmd1 && VAR=值 cmd2` 的变量**只对 cmd2 生效**，前置检查看不到 `DB_DRIVER` | 抽 `scripts/run-mysql-gate.sh`，`export` 到整个脚本作用域 |
| 2 | 心跳红在 `Error: Database not initialized` | 心跳用 `dbHelper.query()`，而 vitest 的 `globalSetup` 与 test worker 是**不同模块上下文**，adapter 在用例里是 `undefined` | 心跳改为**直连** `mysql2`（同一份 `DB_*` 配置），只回答「这个连接是不是 MySQL」 |
| 3 | 心跳文件根本没被收集（日志里一眼看不出它没跑） | `mergeConfig` 对数组是**拼接**不是覆盖 → 基础配置里的 `**/*.mysql.test.ts` 排除仍然生效 | 基础配置展开 + **显式替换** `exclude` |
| 4（终版） | `27 failed / 114 passed`、91 例、`near 'usage = ?'` × 24 | — | ✅ 出生证明 |

另外第 2 次顺带暴露一条「与 MySQL 无关的红」：本地比 CI 多红一个 `tests/api/frontend/frontend.test.ts` —— 因为 **CI 会先 `npm run frontend:build`**，本地缺 `frontend/dist`。入口脚本已加警告（不阻断，门的主职责是方言差异，不是替前端构建把关）。

**建门当日的引擎级预检（不依赖 9999/9720，可与他人测试并行）**

| 探测 | 结果 |
|---|---|
| `SELECT version()` | `8.4.11` ✅ |
| `SELECT sqlite_version()` | `ER_SP_DOES_NOT_EXIST`（errno 1305）✅ 心跳反向守卫成立 |
| `UPDATE t SET usage = 1`（裸列名） | **`ER_PARSE_ERROR`（1064）`near 'usage = 1 …'`** ✅ 复现 #22 |
| ``UPDATE t SET `usage` = 1``（反引号） | OK ✅ 修法方向成立 |
| `INSERT INTO t (id, usage) VALUES …`（裸列名） | `ER_PARSE_ERROR`（1064）`near 'usage) VALUES …'` ✅ 与 SET 同源 |

## 6. 已知边界

- 本门**只在我本机/类 Unix 用 sh 的环境**下可用（npm script 里用了 `${VAR:-default}`）。Windows 请用 Git Bash 或直接 `DB_DRIVER=mysql …` 手工跑。
- 门的用例集与 sqlite 门**同一套**（`vitest.mysql.config.ts` 只把 `**/*.mysql.test.ts` 放回来），所以 `usage` 之外，凡「测试侧写了 sqlite 专有语法」的地方也会在这道门里红——这些要靠方言分流解决，**不允许用 skip 掩盖**。
- 与 sqlite 门**共用** `tests/globalSetup.ts`（会重建库、起 9999 端口的 app）→ 必须走 `test:locked:mysql` 抢锁串行，不能与其它 vitest 并行。
