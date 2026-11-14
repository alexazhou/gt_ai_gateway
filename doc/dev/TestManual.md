# 测试架构文档

本文档描述：
1. 自动化测试运行方式
2. 测试环境的架构设计，包括测试框架、目录结构、数据隔离策略、Mock 服务器实现和全局生命周期配置

---

## 运行测试

### 基本命令

```bash
npm run backend:test                      # node 模式运行所有测试
npm run backend:test -- --run --reporter=verbose  # 详细输出
npm run backend:test -- --run tests/api/user/user.test.ts  # 特定文件
npm run backend:test -- --run -t "should create user"       # 特定用例
```

1. 通常情况下，使用 `npm run backend:test` 命令即可
2. 全量命令可参考 package.json

### 环境变量

测试的逻辑通过环境变量来控制，当前环境变量如下，可组合使用:

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TEST_MODE` | node 或 worker | node |
| `TEST_VERBOSE` | 显示详细日志 | false |
| `TEST_CLEANUP` | 测试后清理数据库 | true |
| `TEST_REAL_API` | 使用真实 API | false |
| `TEST_TIMEOUT` | 超时时间（毫秒） | 30000 |

### ROOT_TOKEN 配置

系统需要配置 `ROOT_TOKEN` 环境变量用于管理员认证。该配置位于项目根目录的 `.dev.vars` 文件中：

```bash
# .dev.vars 文件内容
ROOT_TOKEN=your-admin-token-here
```

**配置说明：**

1. **Node 模式启动**：本地启动服务时（`npm run backend:dev:local`），会自动加载 `.dev.vars` 文件中的 `ROOT_TOKEN`，并监听后端代码变更后自动重启

2. **启动日志验证**：服务启动后会在控制台输出 `ROOT_TOKEN` 的值，便于确认配置是否正确加载

3. **测试服务器**：测试环境启动时会读取 `ROOT_TOKEN` 环境变量

**注意事项：**

- `.dev.vars` 文件不要提交到版本控制系统（已在 `.gitignore` 中）
- 生产环境部署时需要通过 Cloudflare Workers 环境变量配置 `ROOT_TOKEN`

### 示例

```bash
TEST_MODE=worker npm run backend:test                                # worker 模式
TEST_VERBOSE=true TEST_CLEANUP=false npm run backend:test           # 调试模式
TEST_REAL_API=true npm run backend:test                             # 真实 API
```

### MySQL 后端测试

默认测试使用 SQLite。如需以 MySQL 作为后端跑完整的 node 模式测试套件（与 SQLite 并行、相互独立），设置 `DB_DRIVER=mysql` 并配置连接参数即可，测试过程中会自动清空并重建目标库的 schema（必须指向专用测试库，勿指向生产库）：

```bash
npm run backend:test:node:mysql                                    # 即 TEST_MODE=node DB_DRIVER=mysql vitest --run
```

连接参数通过环境变量传入：`DB_HOST`（默认 127.0.0.1）、`DB_PORT`（默认 3306）、`DB_USER`、`DB_PASSWORD`、`DB_NAME`（默认 `test`）。CI 中 `.github/workflows/test.yml` 的 `test-node-mysql` job 使用 `services: mysql:8` 容器运行该套件。

## 测试方法

1. 当遇到测试失败时，先定位失败的用例，从修复其中一条开始。测试是否修复时，也只需要执行这一条，甚至一个方法，这样比较高效
2. 在排查用例失败问题时，可通过测试日志 `log/test/*.log`，来定位问题。如果日志不足以定位，可以加入更多日志


## 测试框架与架构

### 技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| 测试运行器 | Vitest | Vite 原生测试框架 |
| 断言库 | Vitest 内置 | 兼容 Jest 风格的 `expect` |
| HTTP 客户端 | undici | Node.js 推荐的 fetch 实现 |
| 覆盖率 | V8 引擎 | 代码覆盖率报告 |

### 测试目录结构

```
tests/
├── api/                    # HTTP 接口测试（路由 / 中间件 / 鉴权 / 端到端链路）
│   ├── ai/                #   AI Chat / Messages / Responses 接口
│   ├── auth/              #   登录与鉴权矩阵
│   ├── balance/           #   充值 / 账单 / 计费
│   ├── config/            #   系统配置
│   ├── frontend/          #   前端静态资源与 SPA 回退
│   ├── gateway/           #   网关横切（CORS / 端到端业务流 / 协议转换流程）
│   ├── inprocess/         #   进程内 app.request()（不经过子进程，进覆盖率统计）
│   ├── model/             #   模型
│   ├── permission/        #   权限
│   ├── record/            #   请求记录
│   ├── rule/              #   限流规则
│   ├── stats/             #   统计
│   ├── system/            #   系统
│   ├── tenant/            #   租户
│   ├── user/              #   用户
│   └── vendor/            #   供应商
├── integration/           # 集成测试（真库 + ORM 读写 + 跨模块协作）
├── unit/                  # 单元测试（纯内存 / Mock；db / entry / middleware / model /
│                          #   plugin / protocolConverter / script / security / service / util）
├── fixtures/              # 业务实体测试数据与 Token 常量
│   ├── userFixtures.ts    #   USER_FIXTURES（admin 等）/ ADMIN_TOKEN
│   ├── vendorFixtures.ts  #   VENDOR_FIXTURES（openai() / anthropic() …）/ createRandomVendor
│   └── modelFixtures.ts   #   modelFixtures.createRandomModel
├── helpers/               # 测试辅助
│   ├── dbHelper.ts        #   直连测试库（truncate / query / execute）
│   ├── requestHelper.ts   #   HTTP 请求封装
│   ├── mockHelper.ts      #   LLM 请求载荷与用户的快捷生成
│   ├── mockServer.ts      #   Mock AI 服务器实现（9999）
│   ├── mockProxyServer.ts #   Mock HTTP 代理（9997）
│   ├── mockSocksServer.ts #   Mock SOCKS5 代理（9996）
│   ├── ormTestHelper.ts   #   ORM 侧测试辅助
│   ├── migrationTestDb.ts #   建迁移用临时库（交给生产 Adapter）
│   ├── streamLogHelper.ts #   流式日志相关辅助
│   └── upstreamCaptureHelper.ts # 上游请求捕获
├── resource/              # 静态测试资源（SSE 样本日志等）
├── config.ts              # 测试配置（TEST_MODE / 上游 / 日志路径）
└── globalSetup.ts         # 全局生命周期钩子 + setupAdminUser
```

### 测试分类标准

1. **单元测试 (`tests/unit/`)**
   - 只验证单个函数、类或模块的本地逻辑。
   - 不访问真实数据库，不运行 migration，不连接 ORM，不使用 `dbHelper`。
   - 不依赖测试服务器、HTTP API、Cloudflare D1/R2 binding、文件系统持久化或外部进程。
   - 如需隔离依赖，应使用 mock/stub/fake，而不是连接真实资源。

2. **集成测试 (`tests/integration/`)**
   - 只要测试需要访问真实数据库、ORM 连接、migration 后的表结构、对象存储、文件系统持久化或多个 service 的真实协作，就应归类为集成测试。
   - service 层测试如果需要读写 DB，也属于集成测试，不应放在 `tests/unit/`。
   - 通过 HTTP API 验证完整业务流程的测试，可以放在 `tests/integration/`；面向具体 REST 接口契约的测试放在 `tests/api/`。

3. **API 测试 (`tests/api/`)**
   - 通过 `requestHelper` 调用测试服务器，验证接口状态码、响应结构、鉴权、数据持久化和端到端业务行为。
   - **常规的业务数据准备、业务操作和结果验证一律通过 API 完成**，不用数据库直连代替接口行为。
   - 例外白名单（**只有 API 无法暴露这些状态时才允许** `dbHelper.query()` / `dbHelper.execute()` / ORM model query / 原始 SQL）：
     1. 验证落库形态本身（如密文 / 序列化结构 / `end_at` 是否落值）；
     2. 构造 API 造不出来的中间态（如超时未收尾的孤儿记录、特定 `start_at` 偏移）；
     3. 预置无法通过接口设置的初始数据（如用户初始余额）。
     除上述三类，API 测试只用 `dbHelper.truncate()` 做统一隔离。当前 `tests/api/` 下确有此需要的文件共 17 个，改动其中一个的直连用法前请先确认它落在这三类里。
   - Worker 模式下的集成覆盖通常通过 API 请求进入 `wrangler dev` 启动的真实 Worker 服务完成；测试进程本身不直接持有 Worker 的 `DB`、`OBJECT_BUCKET` 等 binding。

4. **Node-only 测试 (`*.node.test.ts`)**
   - 文件名后缀只表示该测试依赖 Node.js 本地能力，worker 模式测试套件会排除这些用例。
   - Node-only 不等于单元测试。若测试访问 DB 或 ORM，应放在 `tests/integration/`，例如 `tests/integration/example.node.test.ts`。

### 测试用例

* 测试文件名中不带有 negative 为正向用例，即验证应该成功的情况
* 带有 negative 的为负向用例，即验证应该失败的情况
* 带有 `.node.test.ts` 后缀的用例为 Node-only 测试，适用于依赖本地文件系统或 Node 专属运行时能力的场景，worker 模式测试套件会排除这些用例。若该测试访问数据库或 ORM，应按集成测试归档

---

## Mock AI 服务器

Mock AI 服务器用来模拟上游的 LLM API。位于 `tests/helpers/mockServer.ts`，使用 Node.js 原生 `http` 模块实现，运行于默认端口 `9999`。

### 支持的 API 端点

| 端点 | 说明 |
|------|------|
| `/chat/completions` | 模拟 OpenAI API（支持流式/非流式响应、token 统计） |
| `/messages` | 模拟 Anthropic API（支持流式/非流式响应、SSE 事件格式） |

---

## 数据隔离策略

### 隔离机制

1. **测试文件级别隔离**：`fileParallelism: false` 确保所有测试文件顺序运行
2. **测试类级别隔离**：每个 `describe` 块开始时清空所有数据表
3. **测试数据自包含**：每个测试在 `beforeAll` 中创建所需的全部数据
4. **数据库重置**：测试文件之间不共享数据状态
5. **数据库生命周期统一管理**：测试不要自行创建或删除测试数据库文件，数据库初始化、migration 和最终清理由 `globalSetup` 与 `dbHelper` 统一负责；测试内通过 `dbHelper.truncate()` 清空数据表

### 典型测试数据流

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import mockHelper from "../../helpers/mockHelper";
import vendorFixtures from "../../fixtures/vendorFixtures";
import modelFixtures from "../../fixtures/modelFixtures";
import dbHelper from "../../helpers/dbHelper";
import { setupAdminUser } from "../../globalSetup";

describe("AI Chat API", () => {
  let adminToken: string
  let userToken: string
  let modelName: string

  beforeAll(async () => {
    await dbHelper.truncate()                              // 1. 清空数据表
    adminToken = await setupAdminUser()                     // 2. 建管理员，拿到 adminToken
    const user = await requestHelper.post(
      "/user/create.json", mockHelper.generateUser(), adminToken,
    )
    userToken = user.body.token                             // 3. 建普通用户
    const vendor = await requestHelper.post(
      "/vendor/create.json", vendorFixtures.VENDOR_FIXTURES.openai(), adminToken,
    )
    modelName = `test-model-${Date.now()}`
    await requestHelper.post(                               // 4. 建模型（单上游路由）
      "/model/create.json",
      modelFixtures.createRandomModel(vendor.body.id, modelName),
      adminToken,
    )
  })

  it("should handle chat request", async () => {
    const response = await requestHelper.post(
      "/llm/v1/chat/completions", { model: modelName }, userToken,
    )
    expect(response.status).toBe(200)
  })
})
```

---

## 全局生命周期

### 配置 (vitest.config.ts)

```typescript
globalSetup: ['./tests/globalSetup.ts'],
pool: 'forks',
fileParallelism: false,  // 顺序执行，避免冲突
```

### Setup 阶段

1. 删除旧数据库文件（如果存在）
2. 创建新数据库并运行 migrations
3. 启动 Mock AI 服务器（可选）
4. 启动测试服务器
5. 初始化日志文件 (`log/test/app.log`, `log/test/mockerServer.log`)

### Test Execution 阶段

- 测试按 `.test.ts` 文件顺序执行
- 每个测试类开始时自动清空所有数据表
- 测试类之间数据完全隔离

### Teardown 阶段

1. 停止测试服务器
2. 停止 Mock AI 服务器（如果已启动）
3. 关闭日志文件流
4. 删除数据库表和文件（由 `TEST_CLEANUP` 控制）

---

## 日志配置

测试运行时自动在 `log/test/` 目录下生成日志文件：

| 文件 | 说明 |
|------|------|
| `app.log` | 测试服务器 stdout/stderr 输出 |
| `mockerServer.log` | Mock AI 服务器请求/响应日志 |

日志格式：`[ISO时间戳] [级别] 消息`

```
[2026-03-05T17:34:39.342Z] [SERVER STDOUT] Starting server...
[2026-03-05T17:34:40.069Z] [MOCK] POST /chat/completions
```

每次运行测试时覆盖旧日志文件。

---
