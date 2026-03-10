# Serverless AI Gateway

一个轻量级的 AI 服务网关，支持 OpenAI 和 Anthropic API 格式的请求转发、模型路由和请求记录。

## 主要功能

- **API 网关**: 统一转发请求到上游 AI 服务（OpenAI、Anthropic、自定义）
- **模型路由**: 支持多个 AI 类型和供应商的映射
- **用户管理**: 基于 Token 的用户认证系统
- **请求记录**: 完整记录所有 AI 请求和响应
- **流式响应**: 支持 SSE（Server-Sent Events）流式输出

## 技术架构

### 后端框架
- **Hono**: 轻量级 Web 框架，支持 Cloudflare Workers 和 Node.js
- **Cloudflare Workers**: 无服务器部署，边缘计算
- **Node.js**: 本地开发环境

### 数据库
- **D1 (Cloudflare)**: 生产环境使用 Cloudflare D1 数据库
- **SQLite**: 本地开发环境使用 SQLite 数据库
- **Sutando**: ORM 框架，提供统一的数据库操作接口


## 使用方式

### 开发环境

#### 启动本地服务器
```bash
# 使用 tsx 启动本地服务器（Node 模式）
npm run backend:dev:local

# 或直接启动
npm run backend:start

# Cloudflare Workers 本地开发模式
npm run backend:dev
```

#### 数据库迁移
```bash
# 本地环境迁移
npm run db:migrate:local

# 查看迁移状态
npm run db:status:local

# 清理本地数据库
npm run db:clear:local
```

### Cloudflare Workers 部署

#### 开发模式
```bash
# 启动 Cloudflare Workers 本地开发环境
npm run backend:dev
```

#### 部署到生产环境
```bash
# 部署到 Cloudflare Workers
npm run backend:deploy
```

### 测试

#### 运行所有测试
```bash
# 运行所有测试
npm run backend:test

# 运行 API 测试
npm run backend:test:api

# 运行集成测试
npm run backend:test:integration

# 生成测试覆盖率报告
npm run backend:test:coverage
```

#### 测试配置

复制 `.env.example` 到 `.env` 并根据需要配置：

```bash
# 服务器配置
TEST_BASE_URL=http://localhost:3000
TEST_PORT=3000

# 数据库配置
TEST_DB_PATH=./test.db

# 上游服务配置
TEST_UPSTREAM_OPENAI_ENABLED=false
TEST_UPSTREAM_ANTHROPIC_ENABLED=false
TEST_UPSTREAM_MOCK_ENABLED=true

# 测试选项
TEST_CLEANUP=true
TEST_TIMEOUT=30000
TEST_VERBOSE=false
```

## 项目结构

```
.
├── src/
│   ├── controller/         # 控制器层
│   │   ├── gatewayController.ts
│   │   ├── userController.ts
│   │   ├── vendorController.ts
│   │   ├── modelController.ts
│   │   ├── recordController.ts
│   │   └── systemController.ts
│   ├── middleware/         # 中间件
│   │   └── authMiddleware.ts
│   ├── model/              # 数据模型
│   │   ├── sgUser.ts
│   │   ├── sgVendor.ts
│   │   ├── sgModel.ts
│   │   └── sgRecord.ts
│   ├── service/            # 服务层
│   │   ├── ormService.ts
│   │   ├── dbAdapter.ts
│   │   ├── userService.ts
│   │   ├── vendorService.ts
│   │   ├── modelService.ts
│   │   ├── recordService.ts
│   │   └── senderService.ts
│   ├── constants.ts        # 常量定义
│   ├── routes.ts            # 路由配置
│   └── local.ts            # 本地服务器入口
├── tests/                 # 测试目录
│   ├── config.ts           # 测试配置
│   ├── setup.ts            # 测试环境设置
│   ├── helpers/            # 测试辅助函数
│   ├── fixtures/           # 测试数据
│   ├── api/                # API 端点测试
│   │   └── auth/           # 认证鉴权测试
│   └── integration/         # 集成测试
├── resource/migrate/      # 数据库迁移文件
├── script/               # 工具脚本
│   └── db.ts             # 数据库迁移工具
├── wrangler.toml          # Cloudflare Workers 配置
├── vitest.config.ts       # 测试配置
└── package.json
```

## 供应商类型

支持的供应商类型：
- `aliyun`: 阿里云通义千问
- `deepseek`: DeepSeek
- `other`: 自定义供应商

## API 格式

支持的 API 格式：
- `openai`: OpenAI API 格式
- `anthropic`: Anthropic API 格式

## 数据库迁移

数据库迁移文件位于 `resource/migrate/` 目录：
- `migrate_0001.sql`: 初始表结构
- `migrate_0002.sql`: 字段更新
- `migrate_0003.sql`: 后续更新
- `migrate_0004.sql`: 添加用户类型字段（支持 normal/admin 用户类型）

## 数据库管理工具

项目提供 `script/db.ts` 脚本用于数据库运维，支持以下命令和环境：

## 命令

| 命令 | 说明 |
|------|------|
| `migrate` | 执行待应用的数据库迁移 |
| `status` | 查看所有迁移文件的应用状态 |
| `clear` | 清空数据库（删除所有自定义表） |

## 环境（`--env`）

| 环境 | 说明 |
|------|------|
| `local`（默认） | 本地 Node.js 环境，操作 `local.db` |
| `worker-local` | Wrangler 本地 D1 模拟器 |
| `worker-cloud` | Cloudflare D1 云端数据库 |

## 使用示例

```bash
# 执行迁移（local 环境）
npm run db:migrate:local

# 查看迁移状态
npm run db:status:local

# 清空数据库
npm run db:clear:local

# 指定 worker 环境
npx tsx script/db.ts migrate --env worker-local
npx tsx script/db.ts migrate --env worker-cloud
```

## 许可证

MIT License
