# #27 测试环境 teardown 留孤儿进程：根因、修法与证据

> 结论先说：`Test environment teardown complete!` 以前是**自称**。端口关了不等于进程死了 ——
> 实测门跑完后机上一夜能攒二十多个 `ppid=1` 的 `src/local.ts`，而且它们换到随机端口继续活着。
> 现已修到「门跑完 `post+30s` 的 `ppid=1` wrapper / loader 双计数 = 0/0」。

## 1. 判据（才算通过）

门（`npm run backend:test:node` 等）跑完后 `post+30s`，同时满足：

| 序号 | 判据 | 取数方式 |
|---|---|---|
| ① | `ppid=1` 的 **wrapper** = 0 | `ps -eo ppid,command \| awk '$1==1 && /node_modules\/\.bin\/tsx src\/local\.ts/'` |
| ② | `ppid=1` 的 **loader** = 0 | `ps -eo ppid,command \| awk '$1==1 && /preflight\.cjs/'` |
| ③ | `:9720` / `:9999` 无 LISTEN | `lsof -iTCP:<port> -sTCP:LISTEN -P -n` |

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

## 5. 对照实验（同命令、同文件，只切 git 内容）

`tests/integration/migrationMode.node.test.ts` 单文件跑法：

```
./scripts/with-test-lock.sh env TEST_MODE=node \
  npx vitest run --config vitest.config.ts tests/integration/migrationMode.node.test.ts
```

| 版本 | 退出码 | `post+5s` 残留 | 归属证据 |
|---|---|---|---|
| 修前（`git stash` 掉本文件改动） | 0 | **2 实例 / 4 进程** | `ps eww` 显示 `PORT=0`、`MIGRATION_MODE=check`、`LOG_DIR=…/gt-migration-mode-logs-*`；`lsof` 显示监听 `60546` / `60547` |
| 修后 | 0 | **0 / 0** | — |

日志：`beta2-record-backup/t27-migrationmode-control-BEFORE.log`（修前）/
`t27-migrationmode-only.log`（修后）。

## 6. 四道门复跑（本提交内）

| 门 | 用例计数 | 退出码 | `post+30s` 残留 |
|---|---|---|---|
| node（`backend:test:node`） | `140 passed (140)` / `1459 passed \| 3 skipped (1462)` | 0 | wrapper=0 / loader=0，9720/9999 LISTEN=0 |
| worker（`backend:test:worker`） | `107 passed (107)` / `1219 passed (1219)` | 0 | wrangler=0 |
| mysql（`test:mysql`） | `27 failed \| 114 passed (141)` / `91 failed \| 1362 passed \| 12 skipped (1465)` | 1（C1 后预期） | wrapper=0 / loader=0 |
| coverage（`backend:test:coverage`） | `140 passed (140)` / `1459 passed \| 3 skipped (1462)`；All files 64.72% stmts / 57.1% branch | 0 | wrapper=0 / loader=0 |

mysql 门的 `27 failed` 与 CI（run `39876661016` / job `120163791890`）失败文件双向 `comm` 为空，
即本提交**没有新增**失败；这 27 个是被测代码 `7f4fba2` 的既有问题，由 C1 负责。

## 7. 边界与纪律

- **不要**用 `lsof -iTCP:9720` 单独作为「无残留」的判据（见 §1）。
- **不要**把「清理失败」写成抛异常：本门语义是「报错但不改变用例结果」。
- `detached: true` 在 macOS 与 Linux 上语义一致（新进程组），但 Windows 无负 PID：
  退化路径会打印 `[CLEANUP] 进程组 kill 失败…`，此时只能保证杀掉直接子进程。
- 本修复只改测试基础设施，**不碰 `src/`**：`git diff --stat` 可验。
