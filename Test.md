# 测试环境准备/停止逻辑文档

## 概述

本文档描述测试环境的初始化、停止流程，以及数据库文件和数据记录的创建/删除时间点。

---

## 全局生命周期

测试使用 Vitest 的 `globalSetup` 功能，在 `tests/globalSetup.ts` 中定义。

### 配置 (vitest.config.ts)

```typescript
globalSetup: ['./tests/globalSetup.ts'],
pool: 'forks',
fileParallelism: false,  // 所有测试文件顺序运行，避免数据库和端口冲突
```

---

## 时间点流程

### 1. Setup 阶段 (开始所有测试前)

`setup()` 函数按以下顺序执行：

| 序号 | 操作 | 文件 | 说明 |
|------|------|------|------|
| 1 | `cleanupTestDatabaseFile()` | `globalSetup.ts:102-107` | 删除旧的数据库文件（如果存在，避免残留数据干扰） |
| 2 | `await initDB()` | `dbHelper.ts:13-28` | 创建新数据库文件并运行 migrations（创建表结构） |
| 3 | `await startMockServer()` | `mockServer.ts:16-37` | 启动 mock AI 服务器（可选，由 `UPSTREAM_CONFIG.mock.enabled` 控制） |
| 4 | `await startTestServer()` | `globalSetup.ts:57-89` | 启动测试服务器（本地 API 服务器，等待 12 秒） |

### 2. Test Execution 阶段 (运行所有测试)

- 测试按 `.test.ts` 文件顺序执行
- 每个测试文件内部按 `describe` 和 `it` 顺序执行
- **每个测试类（describe 块）开始时自动清理所有数据表**
- 数据记录在测试用例中通过 API 调用创建，由每个测试用例自行负责
- 测试类之间数据隔离，互不影响

### 3. Teardown 阶段 (所有测试结束后)

`teardown()` 函数按以下顺序执行：

| 序号 | 操作 | 文件 | 说明 |
|------|------|------|------|
| 1 | `await stopTestServer()` | `globalSetup.ts:91-100` | 停止测试服务器 |
| 2 | `await stopMockServer()` | `mockServer.ts:42-52` | 停止 mock AI 服务器（如果已启动） |
| 3 | `await cleanupDB()` | `dbHelper.ts:88-111` | 删除所有数据库表（**仅在** `TEST_OPTIONS.cleanup === true` 时执行） |
| 4 | `cleanupTestDatabaseFile()` | `globalSetup.ts:102-107` | 删除数据库文件（**仅在** `TEST_OPTIONS.cleanup === true` 时执行） |

---

## 数据库操作详解

### dbHelper.ts 提供的函数

| 函数 | 作用 | 调用时机 |
|------|------|----------|
| `init()` | 创建数据库文件，运行 migrations 创建表结构 | Setup 阶段第 2 步 |
| `cleanup()` | DROP 所有业务表（保留 _migrations 表） | Teardown 阶段第 3 步（可配置） |
| `truncate()` | DELETE 所有表数据，保留表结构 | 每个测试类的 beforeAll 中调用 |
| `query()` | 执行 SELECT 查询 | 测试用例中手动调用 |
| `execute()` | 执行 INSERT/UPDATE/DELETE | 测试用例中手动调用 |
| `getDB()` | 获取数据库实例 | - |
| `close()` | 关闭数据库连接 | 未在当前流程中使用 |

### Migrations 执行逻辑 (dbHelper.ts:33-83)

1. 创建 `_migrations` 表（如果不存在）
2. 读取已应用的 migration 记录
3. 扫描 `resource/migrate/` 目录下的 `.sql` 文件
4. 筛选格式为 `(\d{4})\.sql$` 的文件并排序
5. 找出未应用的 pending migrations
6. 依次执行每个 pending migration 并记录

---

## 数据记录创建/删除

### 创建时间点

数据记录（user、vendor、model、record）在测试用例中通过 API 调用创建：

```typescript
// 示例：在测试用例中创建用户
const response = await post('/user/create.json', userData)
const userId = response.body.id
```

- 每个测试类开始时自动清空所有数据表（通过 `truncateDatabase()`）
- 测试用例需要自行创建所需的数据
- 测试类之间数据完全隔离

### 删除时间点

| 场景 | 删除操作 |
|------|----------|
| 每个测试类开始时 | 调用 `truncateDatabase()` 清空所有数据表 |
| 环境变量 `TEST_CLEANUP !== 'false'` | Teardown 时调用 `cleanupDB()` 删除所有表 |
| 环境变量 `TEST_CLEANUP === 'false'` | 保留数据库文件 |
| 单个测试用例失败 | 不影响其他测试的执行 |

---

## 配置选项

### 环境变量 (config.ts)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TEST_PORT` | `3000` | 测试服务器端口 |
| `TEST_DB_PATH` | `./test.db` | 测试数据库文件路径 |
| `TEST_UPSTREAM_MOCK_ENABLED` | `true` | 是否使用 mock AI 服务器 |
| `TEST_CLEANUP` | `true` | 测试结束后是否清理数据库 |
| `TEST_VERBOSE` | `false` | 是否输出详细日志 |

---

## Mock AI 服务器

### 启动条件

`config.useMockServer` (即 `UPSTREAM_CONFIG.mock.enabled !== 'false'`)

### 功能 (mockServer.ts)

- 模拟 OpenAI `/v1/chat/completions` 接端
- 模拟 Anthropic `/v1/messages` 接口
- 支持流式和非流式响应
- 端口：默认 9999

---

## 关键流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                         Setup 阶段                              │
├─────────────────────────────────────────────────────────────────┤
│  1. 删除旧数据库文件 (如果存在)                                  │
│  2. 创建数据库文件 + 运行 migrations                            │
│  3. 启动 Mock AI 服务器 (可选)                                   │
│  4. 启动测试服务器 (等待 12 秒)                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Test Execution 阶段                        │
├─────────────────────────────────────────────────────────────────┤
│  [system.test.ts] → [user.test.ts] → [vendor.test.ts] → ...   │
│                                                                   │
│  每个测试类 (describe 块)：                                      │
│    1. beforeAll: 调用 truncateDatabase() 清空所有数据表          │
│    2. beforeAll: 创建测试所需的基础数据 (vendor, user 等)        │
│    3. 执行测试用例 (it 块)                                       │
│    4. 测试用例自行创建/验证数据                                  │
│                                                                   │
│  测试类之间数据完全隔离，互不影响                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                       Teardown 阶段                              │
├─────────────────────────────────────────────────────────────────┤
│  1. 停止测试服务器                                                │
│  2. 停止 Mock AI 服务器 (如果已启动)                              │
│  3. [可选] 删除所有数据库表                                      │
│  4. [可选] 删除数据库文件                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 注意事项

1. **顺序执行**：`fileParallelism: false` 确保所有测试文件顺序运行，避免数据库和端口冲突

2. **数据隔离**：每个测试类开始时自动清空数据表，测试类之间数据完全隔离，测试用例需要自行创建所需数据

3. **Cleanup 配置**：默认会清理数据库，可通过 `TEST_CLEANUP=false` 保留数据用于调试

4. **数据库连接**：`truncate()` 函数会自动连接数据库（如果未初始化），确保在测试进程中正常工作

5. **服务器启动等待**：测试服务器启动后固定等待 12 秒，确保服务器完全就绪
