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

## 5. 出生证明（首跑）

见 `#25.result`；日志持久化在 `/Volumes/PDATA/GitDB/beta2-record-backup/`（**不只在 `/tmp`**）。

**建门当日的引擎级预检（不依赖端口，直连 MySQL 8.4.11）**：

| 探测 | 结果 |
|---|---|
| `SELECT version()` | `8.4.11` ✅ |
| `SELECT sqlite_version()` | `ER_SP_DOES_NOT_EXIST`（errno 1305）✅ 心跳反向守卫成立 |
| `UPDATE t SET usage = 1`（裸列名） | **`ER_PARSE_ERROR`（1064）`near 'usage = 1 …'`** ✅ 复现 #22 |
| `UPDATE t SET `` `usage`` ` = 1`（反引号） | OK ✅ 证明修法方向成立 |
| `INSERT INTO t (id, usage) VALUES …`（裸列名） | `ER_PARSE_ERROR`（1064）`near 'usage) VALUES …'` ✅ 与 SET 同源 |

## 6. 已知边界

- 本门**只在我本机/类 Unix 用 sh 的环境**下可用（npm script 里用了 `${VAR:-default}`）。Windows 请用 Git Bash 或直接 `DB_DRIVER=mysql …` 手工跑。
- 门的用例集与 sqlite 门**同一套**（`vitest.mysql.config.ts` 只把 `**/*.mysql.test.ts` 放回来），所以 `usage` 之外，凡「测试侧写了 sqlite 专有语法」的地方也会在这道门里红——这些要靠方言分流解决，**不允许用 skip 掩盖**。
- 与 sqlite 门**共用** `tests/globalSetup.ts`（会重建库、起 9999 端口的 app）→ 必须走 `test:locked:mysql` 抢锁串行，不能与其它 vitest 并行。
