# 测试体系重构与优化方案（修订版）

## 背景

当前项目的自动化测试体系已经具备完善的四道质量门禁（Node SQLite、Node MySQL、Worker D1、V8 覆盖率棘轮），但在多次迭代与专项修复（如协议转换、`P0~P2` 批次验收、`T7` MySQL 门、`#27` 僵尸进程治理）后，测试目录与代码层面积累了明显的演进痕迹：

- 缺少独立的系统生命周期层（`lifecycle`），导致数据库迁移、服务进程启动、引擎探活类测试混杂在 `unit` 与 `integration` 中
- 存在重叠测试文件（如 `gateway/protocol-conversion.test.ts` 与 `ai/protocol-conversion.test.ts`）以及同主题碎片文件
- `tests/helpers/` 与 `tests/fixtures/` 职责重叠，残留了零调用且字段结构已过期的生成函数
- 跑任意单条纯单元测试（`tests/unit/`）也会无条件拉起全套 `globalSetup`，独占 `9720`/`9999`/`9996`/`9997` 端口，导致本机有全量门禁在跑时无法并行调试单测
- 前端已有的 Vitest 单元测试未接入根目录脚本与 CI 独立门禁
- `doc/dev/TestManual.md` 与当前代码现状脱节（示例无法运行、目录结构过期）

本文档梳理现状问题并给出分阶段改造方案。

---

## 改造目标与红线原则

### 目标
1. **四层边界清晰**：建立并严格对齐 `unit`、`lifecycle`、`integration`、`api` 四大平级测试分类：
   - **`tests/unit/`（单元测试）**：纯内存/Mock 逻辑验证，或完全自包含的内存 SQLite（`:memory:`，不写盘、不读全局 `test.db`），无外部进程/端口副作用。
   - **`tests/lifecycle/`（生命周期测试）**：专门验证**数据库迁移（migration）、Schema 演进与约束、服务进程启动（`MIGRATION_MODE` / 子进程拉起）、数据库引擎探活**等系统级生命周期行为。
   - **`tests/integration/`（业务集成测试）**：在已初始化好的测试库上，验证业务 `manager` 层与 `service` 层的 ORM 读写及跨模块协作。
   - **`tests/api/`（HTTP 接口测试）**：通过 HTTP 请求验证路由、中间件、鉴权与端到端业务链路。
2. **消除冗余**：清理过期死代码、重复的数据库/执行器包装逻辑，在不丢失任何独有断言的前提下合并重叠用例。
3. **单测解耦**：让纯单元测试脱离 `globalSetup` 的端口独占（`9720`/`9999` 等）与重建库开销。
4. **门禁完整**：将前端单元测试纳入根目录脚本与 CI 独立 Job。
5. **文档同步**：同步更新 `doc/dev/TestManual.md`，消除过期示例与死代码引用。

### 红线原则（不可违背）
1. **不降低任何断言强度与覆盖率实测值**：
   - `vitest.config.ts`（60/52/60/60）与 `vitest.worker.config.ts`（50/45/50/50）阈值只升不降。
   - **任何测试文件的合并或删除，必须先产出「原 `it` 用例 & 独有断言 → 目标文件落点」一一映射表**，并在合并前后对比实测覆盖率（statements / branches / functions / lines）与总断言数，严禁只凭“测试跑绿”判定通过。
2. **文件名后缀铁律（不破坏门禁分流语义）**：
   - 现有三套配置（`vitest.config.ts`、`vitest.worker.config.ts`、`vitest.mysql.config.ts`）完全依赖文件名后缀 `*.node.test.ts`、`*.mysql.test.ts`、`*.test.ts` 进行用例分流。
   - **搬迁或合并文件时，原文件后缀必须 100% 原样保留**；严禁将 `.node.test.ts` 与 `.test.ts` 混并。
   - 每次搬迁/合并前后，必须核对三道门的收集文件数（collect files）与用例数（collect tests），任何变化必须与预期一一对应并显式记录。
3. **避开发布分支合并冲突窗口**：
   - 在 `rebase/beta2-family*` 分支合并落地前，**不执行跨目录文件搬迁或大范围重命名**；当前窗口只做零冲突的死代码清理、文档同步与前端测试门禁接入。

---

## 现状问题清单

### 1. 测试分层缺失 `lifecycle`，导致 `unit` 与 `integration` 职责混杂

目前测试目录只有 `unit`、`integration`、`api` 三层，没有独立的 `lifecycle`（系统启动与数据库迁移生命周期）分类：
- 本属于系统生命周期（建空库、跑 33 个迁移、拉起独立后端子进程、探测 DB 引擎）的测试散落在 `unit` 和 `integration` 中。
- `tests/unit/` 中混入了落盘创建临时数据库、执行迁移脚本或跨连接共享磁盘文件（如 `rateLimitStore.crossIsolate.node.test.ts`）的测试，阻碍了将 `tests/unit/` 作为免 `globalSetup` 纯单测集合独立运行。

具体待归入 `tests/lifecycle/` 及 `tests/integration/` 的文件如下（注：后缀严格保持不变）：

| 当前路径 | 后缀 | 实际行为 | 目标归属 |
|---------|------|---------|---------|
| [tests/unit/service/dbMigrationService.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/service/dbMigrationService.test.ts) | `.test.ts` | 调用 `createMigrationTestDb()` 建立真实 SQLite 临时文件或 MySQL 临时库，执行全部 33 个迁移脚本并校验 `DROPPABLE_TABLES` 与 `getMigrationMode` | **`tests/lifecycle/`** |
| [tests/integration/migrationMode.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/integration/migrationMode.node.test.ts) | `.node.test.ts` | 自建空库并 `spawn("npx", ["tsx", "src/local.ts"])` 验证不同 `MIGRATION_MODE` 下的真实服务启动与退出行为 | **`tests/lifecycle/`** |
| [tests/integration/dbConstraintMigration.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/integration/dbConstraintMigration.node.test.ts) | `.node.test.ts` | 构造旧版表结构并执行 `migrate_0030` 验证存量重名数据改名与唯一索引迁移 | **`tests/lifecycle/`** |
| [tests/integration/modelRoutingMigration.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/integration/modelRoutingMigration.node.test.ts) | `.node.test.ts` | 构造旧版 `model` 表并执行 `migrate_0026` 验证多上游路由配置迁移 | **`tests/lifecycle/`** |
| [tests/integration/schemaConstraint.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/integration/schemaConstraint.node.test.ts) | `.node.test.ts` | 验证迁移完成后的数据库表级唯一约束现状（`model.name`、`client_config`） | **`tests/lifecycle/`** |
| [tests/unit/db/sqliteDBAdapterExec.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/db/sqliteDBAdapterExec.node.test.ts) | `.node.test.ts` | 创建临时 SQLite 文件，验证迁移器底层 `SQLiteDBAdapter.exec` 执行多语句 DDL/Trigger | **`tests/lifecycle/`** |
| [tests/unit/db/mysqlGateHeartbeat.mysql.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/db/mysqlGateHeartbeat.mysql.test.ts) | `.mysql.test.ts` | 使用 `mysql2/promise` 直连真实 MySQL 容器执行 `SELECT version()` 验证测试门引擎身份 | **`tests/lifecycle/`** |
| [tests/unit/service/rateLimitStore.crossIsolate.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/service/rateLimitStore.crossIsolate.node.test.ts) | `.node.test.ts` | 使用 `mkdtempSync` 创建临时目录与共享 SQLite 磁盘文件，测试多连接并发限流 | **`tests/integration/service/`** |

> **说明**：
> - [deployCloudflare.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/script/deployCloudflare.test.ts) 仅调用 `script/deploy-cloudflare.js` 中的 3 个纯函数（无磁盘、无网络、无子进程），属于纯单元测试，**保留在 `tests/unit/script/`**。
> - [billingSettlementService.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/service/billingSettlementService.node.test.ts)、[sharedStateStores.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/util/sharedStateStores.node.test.ts)、[sqlRateLimitStore.writeCount.node.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/util/rule/sqlRateLimitStore.writeCount.node.test.ts) 经核查均只使用 `new Database(":memory:")` 自包含内存库，不写磁盘文件、不读全局 `test.db`，**保留在 `tests/unit/`**。

将 `lifecycle` 独立出来后，`tests/integration/` 中剩下的文件就全部是纯粹的业务层集成测试：11 个 `*Manager.node.test.ts` + 8 个 `*Service.node.test.ts`（含原 7 个 Service 测试 + 从 `unit/service/` 迁入的 `rateLimitStore.crossIsolate.node.test.ts`），可清晰地按 `manager/` 和 `service/` 两个子目录归类。

---

### 2. 重叠用例与同主题碎片文件

#### 2.1 `gateway/protocol-conversion.test.ts` 与 `ai/protocol-conversion.test.ts` 重叠（含独有断言需迁移）
- [tests/api/gateway/protocol-conversion.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/api/gateway/protocol-conversion.test.ts)（168 行）与 [tests/api/ai/protocol-conversion.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/api/ai/protocol-conversion.test.ts)（第 170~407 行）均测试 OpenAI ↔ Anthropic 的流式与非流式协议转换。
- **差异点核查**：`gateway` 版独有「对同一模型连续发起 non-stream + stream 两次请求后，通过 `getFinalizedRecords(adminToken, 2)` 批量拉取两条记录，并按 `JSON.parse(record.request_data).stream` 分支断言流式/非流式各自的 `record.response_data` 持久化结构（流式落库为上游累加结构 `choices[0].message.content`，非流式落库为转换后结构 `type: "message"`）」。
- **处理方式**：不能直接删除 `gateway/protocol-conversion.test.ts`；必须先将该独有断言合入 `tests/api/ai/protocol-conversion.test.ts` 后再移除冗余文件。

#### 2.2 同主题碎片文件
- **流式总时长上限（P2-23）**：
  - [tests/api/ai/stream-max-duration.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/api/ai/stream-max-duration.test.ts)（99 行，持续吐 chunk 超总时长）与 [tests/api/ai/stream-max-duration-hang.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/api/ai/stream-max-duration-hang.test.ts)（154 行，吐完 2 个 chunk 后挂住超总时长）同为 `.test.ts` 后缀，均验证 `stream_max_duration_ms`，可合并至 `stream-max-duration.test.ts`。
- **前端静态资源与路由共存**：
  - [tests/api/frontend/frontend.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/api/frontend/frontend.test.ts)（190 行）与 [tests/api/frontend/frontendApi.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/api/frontend/frontendApi.test.ts)（51 行）同为 `.test.ts` 后缀，可合并至 `frontend.test.ts`。
- **协议转换工厂单测**：
  - [tests/unit/protocolConverter/ResponsesConverterFactory.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/protocolConverter/ResponsesConverterFactory.test.ts) 第 34~37 行与第 48~51 行是两条完全相同的 `it` 断言；去重后可并入同目录的 [baseAndFactory.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/protocolConverter/baseAndFactory.test.ts)。
  - [tests/unit/protocolConverter/openaiToAnthropicMaxTokens.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/protocolConverter/openaiToAnthropicMaxTokens.test.ts) 可并入 [openaiToAnthropic.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/protocolConverter/openaiToAnthropic.test.ts)。
- **整批回归验收文件保留（仅重命名或不拆散）**：
  - [tests/api/gateway/p2-cleanup.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/api/gateway/p2-cleanup.test.ts) 与 [tests/unit/protocolConverter/protocolConversionFixes.test.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/unit/protocolConverter/protocolConversionFixes.test.ts) 作为整批回归门禁具有集中验收价值，**不拆散**，后续可在目录调整阶段按业务语义重命名（如 `protocolConversionRegression.test.ts`）。

---

### 3. `helpers` 与 `fixtures` 冗余、死代码与规范问题

#### 3.1 零调用且结构已过期的死代码
- [tests/helpers/mockHelper.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/helpers/mockHelper.ts)：
  - `generateVendor`、`generateOpenAIVendor`、`generateAnthropicVendor`、`generateModel`、`randomString`、`randomNumber`、`randomEmail` 共 **7 个导出函数全库零调用**。
  - 其中 `generateVendor` 仍返回旧表结构 `{ url, api_format }`（现为 `urls: {}`），`generateModel` 仍返回旧表结构 `{ vendor_id }`（现为 `routing_mode` + `routing_config`），属于会误导后续开发的过期代码。
- [tests/fixtures/userFixtures.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/fixtures/userFixtures.ts)：
  - `createRandomUser`、`USER_FIXTURES.basic`、`USER_FIXTURES.duplicateName1`、`USER_FIXTURES.duplicateName2` **全库零调用**。
- [tests/fixtures/modelFixtures.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/fixtures/modelFixtures.ts)：
  - `MODEL_FIXTURES` 常量对象（`basic`、`gpt35`、`gpt4`、`claudeHaiku`、`claudeSonnet`）**全库零调用**，所有测试均使用 `modelFixtures.createRandomModel()`。

#### 3.2 `dbHelper.ts` 与测试内部重复辅助代码
- [tests/helpers/dbHelper.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/helpers/dbHelper.ts) 内的 `clearD1LocalDatabase()`（第 197 行）、`clearD1Tables()`（第 238 行）、`dropAllMysqlTables()`（第 356 行）各自重复编写了查表 SQL 与 D1 JSON 输出解析逻辑，未复用同文件第 305 行的 `listBusinessTables()`。
- **SQLite `SqlExecutor` 包装器重复 3 次**：
  - `rateLimitStore.crossIsolate.node.test.ts`、`sharedStateStores.node.test.ts`、`sqlRateLimitStore.writeCount.node.test.ts` 各自重复读取 `resource/migrate/migrate_0033/sqlite.sql` 并手写 `better-sqlite3` 的 `SqlExecutor` 适配器。

#### 3.3 `migrationTestDb.ts` 未遵循默认导出规范
- `GEMINI.md` 编程规范第 5 条要求测试模块统一使用 `default export`。
- [tests/helpers/migrationTestDb.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/tests/helpers/migrationTestDb.ts) 目前使用具名导出（仅被 `dbMigrationService.test.ts` 与 `migrationMode.node.test.ts` 2 个文件引用，改为 `default export` 影响面极小）。
- 注：`globalSetup.ts` 中的 `setupAdminUser` 虽为具名导出，但因涉及 40+ 个文件机械修改 `import` 且无实质行为收益，暂不改动。

---

### 4. 单测端口独占与前端测试门禁缺失

#### 4.1 `globalSetup` 独占端口阻塞单测调试
- [vitest.config.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/vitest.config.ts) 全局挂载了 `globalSetup: ['./tests/globalSetup.ts']`。
- `globalSetup` 启动时会固定绑定 `9720`（被测服务）、`9999`（Mock AI）、`9997`（Mock HTTP Proxy）、`9996`（Mock SOCKS5），并删库重跑 33 个迁移（冷启停固定开销约 1.7s）。
- **核心痛点**：只要本机有一个全量测试门在运行（占用了 `9720`/`9999`），开发者就连一条完全不碰网络和数据库的纯内存单测（如 `maskUtil.test.ts`）都无法运行，直接因端口占用报错退出。

#### 4.2 前端单测未纳入主工程与 CI
- `frontend/src/` 下已有 9 个单元测试文件（配置在 [frontend/vitest.config.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/vitest.config.ts)），但根目录 [package.json](/Volumes/PDATA/GitDB/serverless_ai_gateway/package.json) 没有 `frontend:test` 脚本，[.github/workflows/test.yml](/Volumes/PDATA/GitDB/serverless_ai_gateway/.github/workflows/test.yml) 中也未执行前端单测。

---

### 5. 测试文档（`doc/dev/TestManual.md`）滞后

[doc/dev/TestManual.md](/Volumes/PDATA/GitDB/serverless_ai_gateway/doc/dev/TestManual.md) 存在三处明显滞后：
1. **目录结构树过期**（第 94~113 行）：列出了不存在的 `tests/helpers/db.ts`，缺失 `tests/fixtures/`、`tests/resource/`、`ormTestHelper.ts`、`migrationTestDb.ts`、`mockProxyServer.ts`、`mockSocksServer.ts` 等。
2. **典型代码示例无法运行**（第 171~188 行）：使用了不存在的 `truncateDatabase()`、旧属性 `VENDOR_FIXTURES.openai`（现为函数 `openai()`）以及旧路径 `/v1/chat/completions`（现为 `/llm/v1/chat/completions`）。
3. **API 测试规范描述与实际不符**（第 130~131 行）：文档写明“除 `dbHelper.truncate()` 外，API 测试不应使用 `dbHelper.execute()`、`dbHelper.query()`”，但实际 `tests/api/` 下有 17 个文件因验证底层密文、构造孤儿记录、设置用户初始余额等白盒验证需求调用了 `dbHelper.query/execute`。

---

## 分阶段实施计划（按发布窗口切分）

结合当前 `rebase/beta2-family*` 待合并的时序约束，将改造拆分为 **「第一轮（当前可立即执行，零冲突）」** 与 **「第二轮（待 beta2 合并后执行，涉及文件移动/合并）」**：

### 第一轮：当前窗口立即执行（不移动/重命名现有测试文件，零冲突）

| 步骤 | 改造内容 | 验收标准 |
|------|---------|---------|
| **Step 1.1：死代码清理与文档同步** | 1. 清理 `tests/helpers/mockHelper.ts` 中 7 个零调用且结构过期的函数（`generateVendor`、`generateOpenAIVendor`、`generateAnthropicVendor`、`generateModel`、`randomString`、`randomNumber`、`randomEmail`）<br>2. 清理 `tests/fixtures/userFixtures.ts`（`createRandomUser`、`basic`、`duplicateName1/2`）与 `tests/fixtures/modelFixtures.ts`（`MODEL_FIXTURES`）中的零调用代码<br>3. **同批更新** `doc/dev/TestManual.md`：修正第 94~113 行目录树、第 130~131 行 `dbHelper` 使用规范、第 171~188 行代码示例 | 1. `git grep` 确认被删符号零引用<br>2. `npm run backend:test:type` 通过<br>3. `npm run backend:test` 收集文件数与 `it` 数完全不变 |
| **Step 1.2：前端单测接入与 CI 独立 Job** | 1. 在根目录 `package.json` 新增 `"frontend:test": "cd frontend && npm run test:run"`<br>2. 在 `.github/workflows/test.yml` 新增独立的轻量 `test-unit` Job（运行 `npm run frontend:test` 与 `npm run backend:test:unit`，不阻塞 `test-node`） | 1. 本地运行 `npm run frontend:test` 9 个文件全绿<br>2. CI 独立 Job 同时看守前端单测与免 `globalSetup` 后端纯单测配置 |
| **Step 1.3：新增免 `globalSetup` 的 `vitest.unit.config.ts`** | 1. 新增 `vitest.unit.config.ts`（仅收集 `tests/unit/**/*.test.ts`，exclude `node_modules`、`dbMigrationService.test.ts`、`sqliteDBAdapterExec.node.test.ts`、`mysqlGateHeartbeat.mysql.test.ts`、`rateLimitStore.crossIsolate.node.test.ts`，不挂载 `globalSetup`）<br>2. 根 `package.json` 新增 `"backend:test:unit": "vitest --run --config vitest.unit.config.ts"`，并纳入 Step 1.2 的 CI 轻量 Job 看守（防后续新增 `unit` 用例隐式依赖 `globalSetup`） | 1. 实测基线：`59 files / 736 tests` 全绿（`vitest Duration` 约 `2.9s`）<br>2. 在端口 `9720`/`9999` 被占用时，`npm run backend:test:unit` 仍能独立跑通全绿<br>3. 原 `vitest.config.ts` / `vitest.worker.config.ts` 保持一字不改 |

---

### 第二轮：待 `beta2` 分支合并后执行（目录分层与文件合并）

#### Step 2.1：建立四层目录结构（新增 `tests/lifecycle/`）

将生命周期测试迁入 `tests/lifecycle/`，并将 `tests/integration/` 整理为 `manager/` 与 `service/` 子目录（**严格保留所有文件的 `.test.ts` / `.node.test.ts` / `.mysql.test.ts` 后缀**）：

```text
tests/
├── unit/                           # 纯单元测试（含自包含 :memory: 单测，无磁盘/进程/端口副作用）
│   ├── entry/
│   ├── middleware/
│   ├── model/
│   ├── plugin/
│   ├── protocolConverter/
│   ├── script/                     # deployCloudflare.test.ts（纯函数测试，保留在 unit）
│   ├── security/
│   ├── service/
│   └── util/
├── lifecycle/                      # 系统生命周期测试（DB 迁移、Schema 演进、服务启动、引擎探活）
│   ├── dbMigrationService.test.ts
│   ├── migrationMode.node.test.ts
│   ├── dbConstraintMigration.node.test.ts
│   ├── modelRoutingMigration.node.test.ts
│   ├── schemaConstraint.node.test.ts
│   ├── sqliteDBAdapterExec.node.test.ts
│   └── mysqlGateHeartbeat.mysql.test.ts
├── integration/                    # 业务集成测试（在已初始化的测试库上验证 Manager / Service 协作）
│   ├── manager/                    # 11 个 *Manager.node.test.ts
│   └── service/                    # 8 个 *Service.node.test.ts（含原 7 个 Service 测试 + 从 unit/service/ 迁入的 rateLimitStore.crossIsolate.node.test.ts）
└── api/                            # HTTP API 契约与端到端测试
```

- 同步将 `tests/helpers/migrationTestDb.ts` 改为 `default export`（仅影响 `lifecycle` 下 2 个文件）。
- 此时 `vitest.unit.config.ts` 可简化为直接收集 `tests/unit/**/*.test.ts`；同时新增 `"backend:test:lifecycle": "TEST_MODE=node vitest --run --config vitest.config.ts tests/lifecycle"`。

#### Step 2.2：按「用例落点映射表」合并碎片与重叠文件

在合并以下 4 组同后缀文件前，逐条核对以下落点映射，确保**无任何一条独有断言丢失**：

| 原文件（待移除） | 原文件内 `it` / 独有断言 | 目标文件（合入位置） | 后缀核对 |
|-----------------|------------------------|--------------------|---------|
| `tests/api/gateway/protocol-conversion.test.ts` | 1. `should complete OpenAI client to Anthropic upstream conversion workflow`（同模型连发 non-stream + stream，校验 `getFinalizedRecords(adminToken, 2)`）<br>2. `should complete Anthropic client to OpenAI upstream conversion workflow`（含按 `JSON.parse(record.request_data).stream` 分支校验流式/非流式 `response_data` 结构的独有断言） | `tests/api/ai/protocol-conversion.test.ts`（将 `request_data.stream` 分支断言与双请求记录校验完整迁入） | `.test.ts` → `.test.ts` |
| `tests/api/ai/stream-max-duration-hang.test.ts` | `上游挂住不发数据时，总时长上限应当在窗口内主动中止并落 failed`（1 条 `it` 及 `readChunkOrTimeout` 辅助函数） | `tests/api/ai/stream-max-duration.test.ts` | `.test.ts` → `.test.ts` |
| `tests/api/frontend/frontendApi.test.ts` | 1. `should serve API endpoints alongside frontend`<br>2. `should return JSON 404 for unknown API routes`<br>3. `should allow API operations with admin token` | `tests/api/frontend/frontend.test.ts`（新增 `describe("Frontend-Backend API Coexistence")` 块） | `.test.ts` → `.test.ts` |
| `tests/unit/protocolConverter/ResponsesConverterFactory.test.ts` & `openaiToAnthropicMaxTokens.test.ts` | 1. `ResponsesConverterFactory` 中 **6 条有效 `it`**（原 7 条：第 34/39/44/48/53/93/125 行，去除第 34 行与第 48 行的完全重复项后剩 6 条）<br>2. `openaiToAnthropicMaxTokens` 中 7 条 `it` | 分别合入 `baseAndFactory.test.ts` 与 `openaiToAnthropic.test.ts` | `.test.ts` → `.test.ts` |

**Step 2.1 & 2.2 硬性验收清单（按顺序执行）**：
1. **先执行静态类型检查**：运行 `npm run backend:test:type`，第一时间校验目录深度变化（如 `../../helpers/` → `../helpers/`）后的相对路径引用。
2. **核对三道门的收集数量**：记录改动前、改动后三道门（`vitest.config.ts` Node SQLite 门、`vitest.worker.config.ts` Worker D1 门、`vitest.mysql.config.ts` Node MySQL 门）的 `Test Files` 与 `Tests` 精确数字：
   - Step 2.1（纯搬迁）：三道门的 `Test Files` 与 `Tests` 数量必须 **100% 不变**。
   - Step 2.2（合并 5 个 `.test.ts` 文件，合计移除 `2 + 1 + 3 + 7 + 7 = 20` 条 `it`、回迁 `2 + 1 + 3 + 6 + 7 = 19` 条有效 `it`）：**三道门（Node 门、Worker 门、MySQL 门）**的 `Test Files` 均精确减 5，`Tests` 均精确减 1。
3. **对比覆盖率实测值**：运行 `npm run backend:test:coverage`，对比改动前后的 statements / branches / functions / lines 实测百分比，确认无任何回退。

#### Step 2.3：`dbHelper.ts` 与 SQLite 测试执行器内部去重
1. 收敛 `tests/helpers/dbHelper.ts` 中 `clearD1LocalDatabase()`、`clearD1Tables()`、`dropAllMysqlTables()` 的重复查表逻辑，统一复用 `listBusinessTables(excludeMigrations)`。
2. 将 3 处重复的 `better-sqlite3` `SqlExecutor` 包装器抽取至 `tests/helpers/sqliteTestHelper.ts`（采用 `default export`）。

---

## 已对齐的取舍结论（备查）

1. **内存 SQLite（`:memory:`）测试归属**：采用**选项 B**——自包含、不落盘、不读全局 `test.db` 的 `:memory:` 测试（`billingSettlementService.node.test.ts`、`sharedStateStores.node.test.ts`、`sqlRateLimitStore.writeCount.node.test.ts`）留在 `tests/unit/`；写临时目录共享文件的 `rateLimitStore.crossIsolate.node.test.ts` 归入 `tests/integration/service/`。
2. **批次回归文件（`p2-cleanup.test.ts`、`protocolConversionFixes.test.ts`）**：**不拆散**，保留整批回归的判据完整性。
3. **`script/` 与 `scripts/` 双目录**：本轮**不动**，避免牵动 `package.json`、CI 和 githook。
4. **`setupAdminUser` 默认导出改造**：因需机械修改 40+ 个测试文件 `import` 且无行为收益，**不做**；仅对仅 2 处引用的 `migrationTestDb.ts` 做默认导出规范化。
