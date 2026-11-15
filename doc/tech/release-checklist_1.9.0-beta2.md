# GT AI Gateway v1.9.0-beta2 发布前检查清单

> 状态：**草稿（待小马哥过稿后随发布入库）**，未提交。
> 作者：李哥（测试工程师）｜适用基线：`1.9_dev @ a92fa96`
> 用法：从上到下逐条打勾；**任一条与记录不符就停下来查清，不要「先发出去再补」**。

---

## 零、基线定义（先对清楚再开跑）

| 项 | 值 | 说明 |
|---|---|---|
| 发布基线 HEAD | **`051445e`** | `origin/1.9_dev`（含版本校验脚本修复 #18） |
| 产品代码变更范围 | **`b957356..72552ac`** | 这是唯一会改变产品行为的区间 |
| 测试最后变更 | `3ae4af0` | 反向守卫用例 `try/finally` 加固 |
| 其后提交 | `207305b`（评审稿入库 + `.gitignore`）、`a92fa96`（发布说明范围口径）、`051445e`（版本校验补 `Cargo.lock`，仅 `script/`） | **仅文档 / 测试 / 构建脚本，不含产品代码变更**（产品代码仍止于 `72552ac`） |
| 四道门数字对应 sha | **`3ae4af0`** | `051445e` 与其差异仅 md 与 `script/`，未重跑（差异不触碰 `src/` 与 `tests/`） |
| 台账 | `reviews/ISSUES.md` | 43 项 = 42 VERIFIED + 1 WONTFIX（P2-16 误报） |

- [ ] `git fetch && git rev-parse --short origin/1.9_dev` == `051445e`（或发布负责人指定的新 HEAD，需同步更新本文件第零节与第一节数字）
- [ ] `git log --oneline b957356..72552ac` 复核「产品代码变更范围」这一说法与提交内容一致（区间内 `935f56c`/`e40ecf3` 为用例、`ba007d6`/`72552ac` 为文档）

---

## 一、终验：命令与预期数字（写死可对照）

在**独立 worktree**（本项目：`/Volumes/PDATA/GitDB/sag-verify`）、`git status` 干净、端口与测试锁独占的前提下，串行执行：

| # | 命令 | 文件数 | passed | **skipped** | 预期结果 | 实际 |
|---|---|---|---|---|---|---|
| 1 | `npx tsc --noEmit` | — | — | — | **exit 0** | |
| 2 | `npm run test:locked` | **140** | **1459** | **3** | 合计 1462，exit 0 | |
| 3 | `npm run test:locked:worker` | **107** | **1219** | **0** | 合计 1219，exit 0 | |
| 4 | `npm run test:locked:coverage` | 140 | 1459 | **3** | stmts **64.71** / branch **57.08** / funcs **67.51** / lines **64.93**（地板 **60/52/60/60**），exit 0 | |

- [ ] 四项结果与上表**逐项**一致；不一致时**先定性再改文档**：区分「环境抖动 / 测量方式问题 / 真差异」，禁止直接把文档数字改成实测值
- [ ] 记录实际跑测的 **sha**、开始/结束时间、执行人 —— 发布说明引用的数字必须能追到具体 sha
- [ ] 3 skipped 是**已知且合法**的：`tests/api/rule/sharedStateD1.test.ts` 的 `describe.skipIf(!isWorker)` 三例（真 D1 共享存储只在 worker 有意义，node 门按设计跳过；worker 门里它们会真正执行、故 worker skipped = 0）。**数量变化必须说明原因**

> **注意**：数字对应 `3ae4af0`。若发布 HEAD（如 `051445e`）与 `3ae4af0` 的差异**仅在文档、测试注释或 `script/`**，可在报告里注明「未重跑，差异不触碰 `src/` 与 `tests/` 逻辑」；**只要碰了 `src/` 或测试断言，必须重跑**。

---

## 二、双模式运行前置（不做这四条，跑出来的红全是假的）

- [ ] **抢测试锁**：一律走 `./scripts/with-test-lock.sh <cmd>`（或 `npm run test:locked*`）。
      抢不到就 `exit 1` 停下等 —— **禁止 `rm -rf /tmp/gw-test.lock`**、禁止杀别人的 vitest 进程、只 kill 自己起的 PID。
      残留判定：有锁 + 有 vitest 进程 = 等；有锁 + 无进程 = 可清。
- [ ] **端口独占**：`lsof -nP -iTCP:9999,9720 -sTCP:LISTEN` 无输出才开跑（`tests/config.ts` 里 9720 写死）。
- [ ] **独立 worktree**：不要在多人共用的工作区出数字（`node_modules` / `frontend/dist` 软链进 worktree，软链写进该 worktree 的 `.git/info/exclude`）。
- [ ] **worker 空库迁移**：新 worktree 的 `.wrangler` 是空库，必须先
      `npm run db:migrate:worker-local`（即 `npx tsx script/db.ts migrate --env worker-local`，测试库 `gt_ai_gateway_test` / `wrangler.test.toml`），
      否则 globalSetup 只清表不建表 → **成片假红（踩过：370 红）**。
- [ ] **node 全量串行**，不要与 worker 或 coverage 并行；三件套依次跑。
- [ ] **禁止手动 `rm test.db`**、禁止并发删库重建（会得到 `SQLITE_READONLY_DBMOVED` / `no such table` 成片假红）。

> 排障提示（两条真实测量坑，别当产品缺陷查）：
> 1. **worker 下「连续多次 `dbHelper` CLI 查询后紧跟 HTTP 请求」会 `ECONNRESET`**，与接口无关（只读接口也中招），等 1s 自愈 —— 属 wrangler dev 的 SQLite 连接重连竞态。对策：合并 CLI 查询、HTTP 前置。
> 2. **worker 播种必须一条多值 INSERT**；按行循环 `dbHelper.execute` 会打断 dev server 连接 → 假 `ECONNRESET`。

---

## 三、发布动作（bump → tag → 构建 → 部署 → 部署后冒烟）

> 完整流程见 `doc/tech/release_process.md`；本节只写「发 beta2 这次实际要做、且最容易漏」的部分。

- [ ] **版本号 bump**：`1.9.0-beta1` → `1.9.0-beta2`，实测 **9 个文件 / 12 处**（逐处 grep 核过，不是照抄经验）：

| 文件 | 处数 | 说明 |
|---|---|---|
| `package.json` | 1 | 后端状态接口、页面左下角、仪表盘系统信息都读这里 |
| `package-lock.json` | 2 | 根 `version` + `packages[""].version` |
| `frontend/package.json` | 1 | |
| `frontend/package-lock.json` | 2 | 同上两处 |
| `tauri/package.json` | 1 | |
| `tauri/package-lock.json` | 2 | 同上两处 |
| `tauri/src-tauri/Cargo.toml` | 1 | |
| `tauri/src-tauri/tauri.conf.json` | 1 | |
| `tauri/src-tauri/Cargo.lock` | 1 | **已由脚本校验**（`051445e` 起，按 `Cargo.toml` 的包名定位 `[[package]]` 块取值）。历史上脚本漏查此处，漏改时「脚本全绿但锁文件仍是旧版」，Rust 构建后 cargo 会自动改写它 → 凭空多出一处未提交 diff |

- [ ] bump 后跑 `bash script/verify_versions.sh`：**9 个文件 / 12 处**必须全绿（本地钩子 `script/githook/pre-commit`、CI 的 `Verify Version Consistency`、手工执行三处已同源，均调这个脚本）。注意：**脚本绿 ≠ 已改全**，若本次又新增了版本号出现位置（新的 lock 文件、新的包管理器），要同步加进脚本的 check 列表
- [ ] **tag 与 bump 必须在同一 commit**：`git tag v1.9.0-beta2`（现有 tag 到 `v1.9.0-beta1`），tag 名 = 版本号、带 `v` 前缀、与 `package.json` 严格一致
- [ ] **发布说明改名**：`doc/tech/release-notes_1.9.0-beta1.md` → `doc/tech/release-notes_1.9.0-beta2.md`，与 bump 同一个 commit。理由：文件名与版本不一致，以后翻档案必踩坑（沿用 beta1 是历史遗留，**建议这次改掉**）
- [ ] **构建**：前端 `cd frontend && npm run build`；Tauri 桌面端与 Docker 镜像走 CI。**beta 行为差异**：Tauri 会出安装包但不自动建 GitHub Release；Docker 推 `-betaN` 标签但**不更新 `latest`**
- [ ] **部署**：后端 + 前端 + 迁移（见下一节「升级步骤」）
- [ ] **部署后冒烟（不能只在本机验）**：在真实环境跑四条 —— OpenAI 非流式 / SSE 流式 / Anthropic 协议 / 上游 204-304，确认客户端拿到原状态码、记录口径（`success` vs `upstream_error`）正确、`cost` 合理

---

## 四、升级步骤（交给运维照抄）

- [ ] **备份数据库**（新增表存在，风险低但不可省）
- [ ] **执行迁移 `migrate_0033`**：`npm run db:migrate:node`（或 Worker 环境 `npm run db:migrate:worker-cloud`）
      ⚠️ **Worker 环境漏跑迁移会让限流与上游冷却因缺表报错**（`rate_limit_bucket` / `upstream_health`）
- [ ] **配置自检**（不设置即用默认值）：
      - `sse_max_buffer_bytes` —— 上游 SSE 读缓冲上限
      - `llm_max_body_bytes` —— 请求体上限（超限直接 413）
      - `stream_max_duration_ms` —— 流式总时长兜底（防记录永久停在 `processing`）
- [ ] **管理端自检**：
      - vendor 列表 / 详情里 Token 显示为掩码（`abcd****`），**编辑时留空不会覆盖真 token**
      - 保存模型一次，确认 `No available upstream ... (re-save the model to auto-provision)` 提示消失（配置漂移不再被请求路径静默修复）
- [ ] **升级后冒烟**：一条 OpenAI 非流式、一条流式（SSE）、一条 Anthropic 协议、一个上游 204/304 场景，确认客户端拿到原状态码且记录 `success`/`upstream_error` 口径正确、`cost=0`

---

## 五、回滚口径

**何时必须回滚（量化判据，任一命中即触发，别靠感觉）**

| 现象 | 判据 |
|---|---|
| 5xx 率 | 相对上一版本基线**翻倍**且持续 **≥ 10 分钟**（先排除单一上游故障，勿误判为自身问题） |
| 计费 | 成功率正常但 `cost` **全 0** / **重复扣费** / 金额与 token 用量明显不符 |
| 限流 | 实际放行明显超 rpm（跨 isolate 计数失效 → 共享存储没生效） |
| 记录 | `processing` 大面积堆积，超过 `stream_max_duration_ms` 仍未收尾 |
| 迁移 | 升级后出现缺表类错误（`no such table` / `D1_ERROR`）＝ 迁移未执行或失败 |

- [ ] **代码可回滚**：回退到上一 tag 的代码即可，无破坏性 schema 改动
- [ ] **迁移无需回滚**：`migrate_0033` 只新增表（`rate_limit_bucket` / `upstream_health`），**只增不改、旧版本留着不影响**（旧代码不会读这两张表）
- [ ] 若必须回滚：先回代码、保留新表 → 观察限流是否退化为内存态（跨 isolate 计数可能翻倍），在发布记录里写明该已知限制
- [ ] 回滚后**不要删表**：删表会让「再升回去」多一次迁移风险，留着是安全的

---

## 六、发布后观察项（首 24~48 小时）

- [ ] **`conversion_error` 是否被看板归类**：这是本版新增失败码（协议转换失败），确认统计/告警页能识别，不要落进「未知错误」桶
- [ ] **2xx 非 200 计费口径变化**：本版修了「上游 2xx 但非 200（如 204/304）」的处理，观察**失败率曲线是否跳变**（预期：原先记 FAILED 的 204/304 现在按新口径记录，失败率应下降而非上升）
- [ ] **vendor 掩码的前端兼容**：确认没有前端/脚本把 `abcd****` 当真 token 回传（本版已做 `restoreMaskedProxyUrl` / `resolveUpdatedToken` 兜底，但仍需观察真实流量下的 401 变化）
- [ ] **孤儿回收**：观察 `POST /record/recover-orphans.json` 的返回与耗时（本版从「worker 下 500」修到可用），确认 `recovered` 数量合理、无 `too many SQL variables`
- [ ] **长时间流式**：确认没有记录长期停留在 `processing`（应由 `stream_max_duration_ms` 兜底收尾）
- [ ] 日志里不出现 `String(err)` 泄漏内部栈（本版已收口），若出现按 P1 处理

---

## 附：本清单不覆盖的内容

- 产品功能验收与台账状态（见 `reviews/ISSUES.md`）
- 变更清单与升级说明（见 `doc/tech/release-notes_1.9.0-beta2.md`，发布时由 beta1 改名而来）
- 对外变更摘要（另行出稿，只写用户可见变化，不含内部工程化复盘）
