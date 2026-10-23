# T7：本地 MySQL 门（`npm run test:mysql`）

> 状态：**已建门 + 已推送**（出生证明见 §5）。任务单 `#25`。
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

# 3) 收工（不用 -v：数据卷留着，下次起容器跳过 init，快 5~8s）
docker compose -f docker-compose.test-mysql.yml down
```

`test:mysql` = **前置检查**（`script/check-mysql-gate.ts`，五态）+ `DB_DRIVER=mysql` 跑 `vitest.mysql.config.ts`（与 sqlite 门同一套用例，只换方言）。

`DB_*` 全部复用 `tests/config.ts:52-58` 已有的变量，**不新增配置项**；缺省值与 compose 一致（`127.0.0.1:3306 / root / rootpass / test`），需要覆盖时直接给环境变量。

## 3. 硬要求（已裁定，不得自行放宽）

1. **禁止「连不上就静默回退 sqlite」**：`DB_DRIVER=mysql` 但 3306 不通 → 门**直接 exit 1**，打印脱敏连接串 + `DB_DRIVER` + 引擎探测结果 + 起容器命令。否则「忘了起容器」会得到一条与 #22 一模一样的假绿。
2. **方言心跳两条互为反证**（`tests/unit/db/mysqlGateHeartbeat.mysql.test.ts`）：
   - `SELECT version()` 必须**成功**（连对引擎）；
   - `SELECT sqlite_version()` 必须**抛错**（连错引擎时它必然成功 → 报警）。
   - **`@@version` 方案禁用**：它在 SQLite 报 `unrecognized token: "@"`，是**语法错**不是**引擎错**，会与「SQL 写错」混淆。
3. **报错文案**必须包含：脱敏连接串（`mysql://root:***@127.0.0.1:3306/test`）、`DB_DRIVER`、引擎探测结果、起容器命令。
4. **出生证明五要素**（见 §5）：被测代码 sha + 门自身 sha + 取数时刻 + 日志路径（**不得只放 `/tmp`**）+ **依赖来源链**。
5. **删除条件写死**：CI 的 MySQL job **连续 20 个 run 全绿**之后才可讨论降级；且必须承认「本地门管新红可见、CI 管合入前把关」，**不可互相替代**。
6. **实例同一性必须可判**：`SELECT version()` 只证明「连到的是 MySQL」，不证明「连到的是本容器」。门用 `@@hostname`（compose 固定 `hostname: t7-mysql-gate`）判定，且**必须零 schema / 零表 / 零 DDL**（见 §5.1 第 5、6 条的教训）。

## 4. 为什么先建门、再修 #22（顺序不能反）

先修 `#22` 再建门 → **永久拿不到出生证明**，只剩两条人手贴的日志（「人手贴的证据」最容易被后来的自己相信）。先建门 → 「红 → 绿」是**门自己产出的证据链**，谁都不用自证。代价是门会先红一段时间（看着像「把门弄坏了」），所以出生证明必须留两处：commit message + `#25.result` 里贴同一份红日志原文（带取数时刻与 run id）。

## 5. 出生证明（首跑必红）

**五要素**

| 要素 | 值 |
|---|---|
| 被测代码 sha | **`7f4fba2`**（`usage` 仍裸 = 修复前状态） |
| **门自身 sha** | **`324e5a0`**（门代码终版；本文件单独 commit，只改文档） |
| 取数时刻 | **2026-10-23T08:55:15+0800**（run 起点；进程结束 08:58:15） |
| 日志路径 | `/Volumes/PDATA/GitDB/beta2-record-backup/t7-gate-324e5a0-run1.log`（**持久位，不在 `/tmp`**） |
| 依赖来源链 | `sag-t7/node_modules` → `sag-verify/node_modules` → **主工作区 `node_modules`**（依赖树来自主工作区 `7f4fba2` 那次安装；`frontend/dist` 同样软链自 `sag-verify`） |
| worktree / 容器 | `/Volumes/PDATA/GitDB/sag-t7` / `mysql:8`（8.4.11，`hostname=t7-mysql-gate`，healthy） |

**结果：红（预期）**

```
Test Files  28 failed | 113 passed (141)
     Tests  93 failed | 1360 passed | 12 skipped (1465)
[gate-exit] 1
```

- 红在 **`near 'usage = ? WHERE id = ?' at line 1`**（`ER_PARSE_ERROR` / errno 1064）
- 心跳 3 例全过：`✓ tests/unit/db/mysqlGateHeartbeat.mysql.test.ts (3 tests) 41ms`、`[mysql-gate] 引擎探测成功：8.4.11`
- 实例身份：`实例身份（@@hostname）: OK → t7-mysql-gate（期望 t7-mysql-gate）`

**与 CI 的对账（独立取数，不是我复述自己）**

CI = run **`39876661016`** / job **`120163791890`**（`Test (Node Mode, MySQL)`，`1.9_dev @ 7f4fba2`）：

| | 本地门（`324e5a0`） | CI（同 sha） | 差 |
|---|---|---|---|
| Test Files | `28 failed \| 113 passed (141)` | `27 failed \| 113 passed (140)` | +1 文件（本地多心跳文件，通过）+1 失败 |
| Tests | `93 failed \| 1360 passed \| 12 skipped (1465)` | `91 failed \| 1359 passed \| 12 skipped (1462)` | +3 例（心跳，通过）+2 失败 |

失败**文件**清单双向 `comm` 差集：

- 仅本地多出：`tests/unit/service/dbMigrationService.test.ts`
- 仅 CI 多出：**空**

→ 即「**27 个失败文件逐位一致**；唯一的本地增量不是产品问题，是这两例的 5s timeout 在本机（OrbStack VM 里的 MySQL）全量并发跑时被顶穿」（定性见 §5.2）。

**既有门不受影响（实测，不是推理）**：`vitest.worker.config.ts` 追加了 `**/*.mysql.test.ts` 排除，所以必须复跑 worker 门：
`107 passed (107)` / `1219 passed (1219)` / `exit 0`（2026-10-23T09:01:41→09:08:28，日志 `t7-worker-gate-324e5a0.log`）——
与建门前基线**逐位相同**。
sqlite node 门：`140 passed (140)` / `1459 passed | 3 skipped (1462)` / exit 0（日志 `t7-sqlite-gate-unaffected.log`，取数 08:37:13；此后本分支的改动都落在 MySQL 门专属文件里，未再触及基础配置）。

**提交结构**（`7f4fba2` 起，**全程 no amend**）

| sha | 内容 |
|---|---|
| `1613d5a` | 门本体（compose + `test:mysql` + 方言心跳 + 配置排除） |
| `72921f2` | 本文档（出生证明 + 建门过程） |
| `c12bf61` | 硬化 ①：marker 表（测试库）+ 五态预检 —— **方案后被推翻，见 §5.1** |
| `c5fc6e1` | 硬化 ②：marker 表挪独立库 `t7_gate` —— **方案后被推翻，见 §5.1** |
| `324e5a0` | **门代码终版**：实例身份改用 `@@hostname` |

为什么文档单列 commit 而不是 amend 进门里：**amend 会改写 sha，出生证明里的「门自身 sha」就再也对不上任何真实提交** —— 证据链优先于提交整洁。

### 5.1 建门过程：6 次首跑，5 次都被「门自身的缺陷」拦下

这段保留是因为它证明了一件事：**门也需要被证据验证**（R5）。全部不是产品问题，都是门自己写错：

| 跑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `[FATAL] DB_DRIVER=sqlite`，门把自己拦住了 | `package.json` 里 `cmd1 && VAR=值 cmd2` 的变量**只对 cmd2 生效**，前置检查看不到 `DB_DRIVER` | 抽 `scripts/run-mysql-gate.sh`，`export` 到整个脚本作用域 |
| 2 | 心跳红在 `Error: Database not initialized` | 心跳用 `dbHelper.query()`，而 vitest 的 `globalSetup` 与 test worker 是**不同模块上下文**，adapter 在用例里是 `undefined` | 心跳改为**直连** `mysql2`（同一份 `DB_*` 配置），只回答「这个连接是不是 MySQL」 |
| 3 | 心跳文件根本没被收集（日志里一眼看不出它没跑） | `mergeConfig` 对数组是**拼接**不是覆盖 → 基础配置里的 `**/*.mysql.test.ts` 排除仍然生效 | 基础配置展开 + **显式替换** `exclude` |
| 4 | `27 failed / 114 passed (141)`、91 例、`near 'usage = ?'` × 24 | — | ✅ 当时的出生证明 |
| 5 | **连跑第二次** → `[FATAL-④]` exit 1，说「连到的不是本次容器」——但容器是对的 | marker 表建在测试库 `test` 里，而 `tests/helpers/dbHelper.ts:331-343` 的 `initDatabase()` 在 MySQL 模式下**开头**就 `dropAllMysqlTables()`（无条件 DROP `DATABASE()` 内所有表，为的是每轮从空库重跑 33 个迁移）→ marker 第一跑就被门自己删了 | marker 挪独立库 `t7_gate`（下一步证明也不对） |
| 6 | 独立库方案跑起来后，`dbMigrationService.test.ts` 稳定多红 1~2 例（`Test timed out in 5000ms`） | **多一个 schema 让迁移慢约 2.5s**：A/B 实测（单文件、容器热、同一份代码）有 `t7_gate` 库 → 5313/5262ms 红；`DROP DATABASE t7_gate` → 3023/2649ms 绿；重建库再跑 → 5396/5373ms 红。**可重复** | 身份证据改用 **`@@hostname`**（零 schema/零表/零 DDL） |

第 5、6 条的教训是同一条：**检查器本身会制造证据**。第 5 条是「检查器误报」（把人指向 3306 和 `down -v`，而真因是它自己删了证据），第 6 条是「检查器让被测套件多红」——比没有检查器更坏，因为多出来的红会被当成本来就有的红。

第 6 次顺带留下一条与 MySQL 无关的红：本地比 CI 多红一个 `tests/api/frontend/frontend.test.ts` —— 因为 **CI 会先 `npm run frontend:build`**，本地缺 `frontend/dist`。入口脚本已加警告（不阻断，门的主职责是方言差异，不是替前端构建把关）。

**五态预检的反证（每态都有能让它失败的实验）**

| 态 | 实验 | 结果 |
|---|---|---|
| ① 方言不对 | 不带 `DB_DRIVER=mysql` | exit 1 `FATAL-①` |
| ② 端口被占 | 起 dummy 占 9999 | exit 1 `FATAL-②`，文案明说「这**不是** MySQL 的问题」，只列残留 PID **不代杀** |
| ③ 连不上 | `DB_PORT=3399` | exit 1 `FATAL-③` + 起容器命令 |
| ④ 实例身份不符 | `T7_GATE_HOSTNAME=not-a-mysql-gate`（容器实际是 `t7-mysql-gate`） | exit 1 `FATAL-④`「期望 hostname "not-a-mysql-gate"，实得 "t7-mysql-gate"」 |
| ⑤ 全通 | 默认参数 | exit 0 |

日志：`t7-preflight-negative.log`（①②③④⑤ 旧四态+坏端口）、`t7-preflight-hostname-negative.log`（④ 的 hostname 反证 + ⑤ 正证）。

**建门当日的引擎级预检（不依赖 9999/9720，可与他人测试并行）**

| 探测 | 结果 |
|---|---|
| `SELECT version()` | `8.4.11` ✅ |
| `SELECT sqlite_version()` | `ER_SP_DOES_NOT_EXIST`（errno 1305）✅ 心跳反向守卫成立 |
| `UPDATE t SET usage = 1`（裸列名） | **`ER_PARSE_ERROR`（1064）`near 'usage = 1 …'`** ✅ 复现 #22 |
| ``UPDATE t SET `usage` = 1``（反引号） | OK ✅ 修法方向成立 |
| `INSERT INTO t (id, usage) VALUES …`（裸列名） | `ER_PARSE_ERROR`（1064）`near 'usage) VALUES …'` ✅ 与 SET 同源 |

### 5.2 已知的本地 / CI 差异（`dbMigrationService.test.ts`，**不是门引入的**）

`tests/unit/service/dbMigrationService.test.ts` 里两个用例各自要跑完 33 个迁移，用的是 vitest 默认 `testTimeout: 5000`。

| 跑法 | 耗时 | 结果 |
|---|---|---|
| 单文件隔离跑（同一个容器、同一份代码） | 3067ms / 2686ms（另一次 3023ms / 2649ms） | ✅ 7 例全绿 |
| 全量并发跑（141 文件同跑） | 文件总 7443 ~ 10752ms | ❌ 1~2 例 `Test timed out in 5000ms` |

六次全量跑的实测矩阵（用来证明这是**边界性抖动、不是稳定失败**）：

| 时刻 | 门 sha | Test Files | Tests | `dbMigrationService` |
|---|---|---|---|---|
| 08:34（旧卷·门本体） | `1613d5a` | 27 failed / 114 passed (141) | 91 / 1362 / 12 (1465) | ✅ 绿（文件 7678ms） |
| 08:41 | `c12bf61` | 28 / 113 (141) | 93 / 1360 (1465) | ❌ 2 例 |
| 08:46 | `c5fc6e1` | 28 / 113 (141) | 92 / 1361 (1465) | ❌ 1 例 |
| 08:49 | `c5fc6e1` | 28 / 113 (141) | 93 / 1360 (1465) | ❌ 2 例 |
| 08:55 | `324e5a0` | 28 / 113 (141) | 93 / 1360 (1465) | ❌ 2 例（10752ms） |
| 08:58 | `324e5a0` | 28 / 113 (141) | 92 / 1361 (1465) | ❌ 1 例（7443ms） |

- CI（原生 Linux Docker）上该文件**不红**；本机 MySQL 跑在 OrbStack 的 VM 里，全量并发下 DDL 慢一档 → 顶穿 5s。
- **本门没有为它放宽任何东西**：不改 `testTimeout`、不 skip、不缩范围。要不要把这两例的 timeout 提到 15~20s，属**独立决定**（会动被测测试文件），需 `#25` 验收人裁定；不裁定的话，本地 MySQL 门的总数就固定是 `28 / 113 (141)`，比 CI 多这 1~2 例噪声。

## 6. 已知边界

- 本门**只在我本机/类 Unix 用 sh 的环境**下可用（npm script 里用了 `${VAR:-default}`）。Windows 请用 Git Bash 或直接 `DB_DRIVER=mysql …` 手工跑。
- 门的用例集与 sqlite 门**同一套**（`vitest.mysql.config.ts` 只把 `**/*.mysql.test.ts` 放回来），所以 `usage` 之外，凡「测试侧写了 sqlite 专有语法」的地方也会在这道门里红——这些要靠方言分流解决，**不允许用 skip 掩盖**。
- 与 sqlite 门**共用** `tests/globalSetup.ts`（会重建库、起 9999 端口的 app）→ 必须走 `test:locked:mysql` 抢锁串行，不能与其它 vitest 并行。
- 门运行期间**禁止在别处 `npm ci`**（R9）：`npm ci` 会整目录删除 `node_modules`，本门依赖链是**软链**（`sag-t7/node_modules → sag-verify/node_modules → 主工作区`），一旦被删，正在跑的门会变成 `ENOENT`，事后必被误判成「环境偶发」。
- 容器重建后**第一跑**比后续慢（MySQL 数据目录刚初始化），但不会改变红点清单（`dbMigrationService` 的超时另有原因，见 §5.2）。
