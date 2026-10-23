# #27 测试环境 teardown 留孤儿进程：根因、修法与证据

> 结论先说：`Test environment teardown complete!` 以前是**自称**。端口关了不等于进程死了 ——
> 实测门跑完后机上一夜能攒二十多个 `ppid=1` 的 `src/local.ts`，而且它们换到随机端口继续活着。
> 现已修到「门跑完 `post+30s` 的 `ppid=1` wrapper / loader 双计数 = 0/0」。

## 1. 判据（才算通过）

门（`npm run backend:test:node` 等）跑完后，同时满足：

| 序号 | 判据 | 取数方式 |
|---|---|---|
| ① | **按工作区路径匹配的测试服务进程总数 = 0** | 见下方 `[RESIDUAL]` 行；手工复核用 `ps -Ao pid,ppid,command \| grep -F "<worktree>/" \| grep -F "src/local.ts" \| wc -l`（loader 的 argv 里没有工作区路径，需连同其父 wrapper 一起数，见 §2） |
| ② | `:9720` / `:9999` 无 LISTEN | `lsof -iTCP:<port> -sTCP:LISTEN -P -n` |

**取数放在日志里，不靠事后另跑 `ps`**：`teardown()` 收尾会无条件打印一行（成功/失败都打）

```
[GLOBAL_TEARDOWN][RESIDUAL] worktree=<path> count=<n|unknown> ports=9720,9999 busy=<列表|none>
```

`count=unknown` 表示**进程枚举本身失败了**（不是「机器很干净」）。这是有意的：宁可报 unknown，
也不把「检查器坏了」显示成 0 —— 与 `Test environment teardown complete!` 同类错误不能再犯第二次。

> **⚠️ 已被推翻的判据（#29 修正，留档防复发）**：本文件初版写的是
> 「① `ppid=1` 的 wrapper = 0；② `ppid=1` 的 loader = 0」。**② 是永真的（R6）**：
> 实测孤儿长这样 —— `wrapper ppid=1` + `loader ppid=wrapper`。loader 的父进程是那个被遗留的
> wrapper，所以 loader 的 `ppid` **永远不会是 1**，这条判据再也没机会失败。
> 正确口径是「按工作区路径匹配的进程**总数** = 0」（wrapper + 它的子孙一起数）。

**`lsof -iTCP:9720` 为空不能当唯一判据**：9720 确实会关掉，但存活下来的 wrapper/loader
会绑定一个 5xxxx 随机端口（下面 §5 的对照实验里实测是 `127.0.0.1:60546` / `:60547`）。
只看 9720 就会把「进程还在」误判成「已经清干净」。

## 2. 进程树长什么样（实测，不是推断）

`spawn("npx", ["tsx", "src/local.ts"])` 起来的不是一层，而是三层：

```
vitest ──> npx                      ← child.pid / testServerProcess.pid 指的是**这个**
             └─> wrapper  node …/node_modules/.bin/tsx src/local.ts        （不监听任何端口）
                   └─> loader  node --require …/tsx/dist/preflight.cjs … src/local.ts   （真持 socket）
```

## 3. 根因：杀错了 pid

两个 spawn 站点，都是「拿 `child.pid`（npx）当服务本体」：

| 站点 | 原代码 | 后果 |
|---|---|---|
| `tests/globalSetup.ts` `startTestServer()` | `spawn("npx", ["tsx", …])` + `stopTestServer()` 里 `testServerProcess.kill("SIGTERM")` | npx 收到信号退出，wrapper/loader 被 reparent → `ppid=1` 孤儿 |
| `tests/integration/migrationMode.node.test.ts` `spawnBackend()` | `child.kill("SIGTERM")` / `child.kill("SIGKILL")` | 同上；本文件 2 个「能起来」的用例各留 1 个实例 |

`stopTestServer()` 原来那个 5s 后 `SIGKILL` 兜底同样只打 npx，所以**兜底也兜不住**。

> 补充实测（顺带排掉一个错误猜想）：SIGTERM **打到 wrapper 上**是有效的（`kill -TERM <wrapper pid>`
> 后 wrapper + loader 一起消失）。所以问题不是「tsx 不转发信号」，而是**信号根本没到 wrapper**。

## 4. 修法

1. **独立进程组**：两处 spawn 都加 `detached: true` → `pgid == child.pid`，整棵树同组。
2. **按组打**：`process.kill(-pid, signal)`（负 PID = 进程组）；`ESRCH` 静默，其他错误退化
   为 `child.kill()` 并 `console.error`（**不静默**）。
3. **升级链路**：SIGTERM 整组 → 5s 不退 → SIGKILL 整组 → 2s。`globalSetup` 的
   `stopTestServer()` 为此改成 async（先挂 `exit` 监听再发信号，避免漏事件）。
4. **终检**：`teardown()` 末尾自己 bind 一次 9720（以及 `config.useMockServer` 时的 9999），
   2s 内必须空出来；空不出来就 `console.error` + 列出残留 PID。
5. **不抛**：清理失败只报错，不 throw —— 否则一次清理抖动会把绿门改写成基础设施红，
   真实用例失败反而被淹没。
6. **反证脚本**：`script/verify-teardown-sigkill.ts` —— 起一个**忽略 SIGTERM** 的 stub server，
   断言「SIGTERM 后仍活着」→「SIGKILL 后进组消失 + 端口释放」。没有这个实验，
   「升级 SIGKILL 有效」就只是自称。

## 5. 对照实验（同命令、同文件、同 worktree，只切用例文件内容）

`tests/integration/migrationMode.node.test.ts` 单文件跑法：

```
./scripts/with-test-lock.sh env TEST_MODE=node \
  npx vitest run --config vitest.config.ts tests/integration/migrationMode.node.test.ts
```

两次跑前后各做一次彻底清理（`pkill -KILL -f "src/local.ts"` 直到计数 0），
所以两侧都是从零开始；**残留数字全部取自日志里的 `[RESIDUAL]` 行**，不靠事后补 `ps`：

| 版本 | 退出码 | 日志内 `[RESIDUAL]` | `settle_ms` | 明细（日志里逐条列出） |
|---|---|---|---|---|
| 修前（用例回退到 `7f4fba2` 版） | 0 | **count=4** | 2032（等满仍未清零） | 2 个 wrapper（`ppid=1`）+ 2 个 loader（`ppid` = 各自的 wrapper） |
| 修后（`481c967` 版用例） | 0 | **count=0** | 47 | — |

日志：`beta2-record-backup/t29-migrationmode-BEFORE.log` / `t29-migrationmode-AFTER.log`
（各自含 `[BEFORE-start]`/`[AFTER-start]` 时间戳 + vitest 汇总 + `[RESIDUAL]` 行，**自包含**）。

> 取数时刻：2026-10-23T22:32:28（BEFORE）/ 22:32:47（AFTER），同一 worktree `sag-t27`、
> 同一命令、同一分支状态，只把用例文件内容在两版之间切换；两次跑之间做了彻底清理（计数 0）。

**这一组同时证伪了三条旧判据**：

1. 「`:9720` 空 = 干净」—— 修前那两次跑 `busy=none`（端口确实释放了），但残留 4 个进程；
2. 「`ppid=1` 的 loader = 0」—— 实测 loader 的 `ppid` 是 **wrapper 的 pid**（`83233 ← 83232`），
   永远不等于 1，这条判据永真（见 §1 注）；
3. 「快照计数」—— 修后第一次实现用瞬时快照，抓到一个正在退出的 loader 而误报 `count=1`；
   改成「轮询到清零，最多 2s」（`settle_ms` 就是实际等了多久）后才有稳定读数。
   真孤儿不会自己消失，所以轮询**不会**把问题洗白：上表修前照样报 4、`settle_ms` 等满。

### 5.1 测量命令自身会被数进来（踩过，已修）

第一版 `isServer()` 只是 `/src\/local\.ts|wrangler dev/`，于是全量门跑完报 `count=1`，
`pid=79563` 的命令行是**我自己那条 `bash -c … grep -F '/…/sag-t27/' … grep -F 'src/local.ts'`** ——
测量命令把自己数成了残留（自匹配假警报）。现在收紧为：

- `bash -c` / `sh -c` / `zsh -c` 开头的命令行 → 一律不算（我们两处 spawn 都不走 shell）；
- 必须同时满足「含 `src/local.ts`」**且**「是 `node_modules/.bin/tsx` 或 `tsx/dist/preflight.cjs`
  或 `tsx/dist/loader.mjs`」；`wrangler dev` 单独放行。

分类器已验证四向：测量 shell → ignore；wrapper → MATCH；loader → MATCH；`node /x/foo.js` → ignore。

## 6. 四道门复跑（本分支内，`fix/t27-teardown-orphans`）

| 门 | 用例计数 | 退出码 | 日志内 `[RESIDUAL]` | `post+30s` 实测 |
|---|---|---|---|---|
| node（`backend:test:node`） | `140 passed (140)` / `1459 passed \| 3 skipped (1462)` | 0 | `count=0 settle_ms=46` | count=0 |
| worker（`backend:test:worker`） | `107 passed (107)` / `1219 passed (1219)` | 0 | 见日志 | 见日志 |
| mysql（`test:mysql`） | `27 failed \| 114 passed (141)` / `91 failed \| 1362 passed \| 12 skipped (1465)` | 1（C1 后预期） | 见日志 | — |
| coverage（`backend:test:coverage`） | `140 passed (140)` / `1459 passed \| 3 skipped (1462)`；All files 64.72% stmts / 57.1% branch | 0 | 见日志 | — |

mysql 门的 `27 failed` 与 CI（run `39876661016` / job `120163791890`）失败文件双向 `comm` 为空，
即本提交**没有新增**失败；这 27 个是被测代码 `7f4fba2` 的既有问题，由 C1 负责。

日志：`beta2-record-backup/t29-{node,worker,mysql,coverage}-gate.log`。

## 7. 边界与纪律

- **不要**用 `lsof -iTCP:9720` 单独作为「无残留」的判据（见 §1）。
- **不要**把「清理失败」写成抛异常：本门语义是「报错但不改变用例结果」。
- `detached: true` 在 macOS 与 Linux 上语义一致（新进程组），但 Windows 无负 PID：
  退化路径会打印 `[CLEANUP] 进程组 kill 失败…`，此时只能保证杀掉直接子进程。
- 本修复只改测试基础设施，**不碰 `src/`**：`git diff --stat` 可验。
