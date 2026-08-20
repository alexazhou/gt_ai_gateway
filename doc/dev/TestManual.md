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
├── api/                    # API 接口测试
│   ├── ai/                # AI Chat API 测试
│   ├── model/             # Model API 测试
│   ├── record/            # Record API 测试
│   ├── system/            # System API 测试
│   ├── user/              # User API 测试
│   └── vendor/            # Vendor API 测试
├── integration/           # 集成测试
├── unit/                  # 单元测试
├── config.ts             # 测试配置文件
├── globalSetup.ts        # 全局测试生命周期钩子
└── helpers/              # 测试辅助函数
    ├── db.ts            # 数据库连接工具
    ├── dbHelper.ts      # 数据库操作辅助
    ├── mockHelper.ts    # Mock 数据生成器
    ├── mockServer.ts    # Mock AI 服务器实现
    └── requestHelper.ts # HTTP 请求封装
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
   - API 测试的数据准备、业务操作和结果验证都应通过 API 完成，不直接访问数据库来插入、修改或判断业务数据。
   - 除统一测试隔离所需的 `dbHelper.truncate()` 外，API 测试不应使用 `dbHelper.execute()`、`dbHelper.query()`、ORM model query 或原始 SQL 直接操作数据库。
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
describe('AI Chat API', () => {
  beforeAll(async () => {
    await truncateDatabase()                 // 1. 清空数据库
    const user = await post('/user/create.json', generateUser())
    testUserToken = user.body.token           // 2. 创建用户
    const vendor = await post('/vendor/create.json', VENDOR_FIXTURES.openai)
    vendorId = vendor.body.id                  // 3. 创建供应商
    const model = await post('/model/create.json', createRandomModel(vendorId, 'gpt-3.5-turbo'))
    modelName = model.body.name               // 4. 创建模型
  })

  it('should handle chat request', async () => {
    const response = await post('/v1/chat/completions', { model: modelName }, testUserToken)
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
