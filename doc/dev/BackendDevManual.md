# 后端开发手册

本文档描述如何进行后端项目开发，包括环境配置、后端架构、开发规范等。

---

## 后端技术栈

| 部分 | 技术栈 | 说明 |
|------|--------|------|
| **后端框架** | Hono + TypeScript | 轻量级 Web 框架 |
| **运行时** | Cloudflare Workers / Node.js | 无服务器 / 本地运行 |
| **数据库** | D1 (Cloudflare) / SQLite | 生产 / 开发环境 |
| **ORM** | Sutando | 统一数据库操作接口 |

## 后端项目结构

```
.
├── src/                   # 后端源代码
│   ├── controller/        # 控制器层
│   ├── middleware/        # 中间件
│   ├── model/            # 数据模型
│   ├── service/          # 服务层
│   ├── constants.ts      # 常量定义
│   ├── routes.ts         # 路由配置
│   └── local.ts          # 本地服务器入口
├── tests/                # 测试目录
├── resource/migrate/     # 数据库迁移文件
├── script/              # 工具脚本
├── wrangler.toml        # Cloudflare Workers 配置
└── package.json         # 项目依赖
```

---

## 环境配置

### 前置要求

- Node.js (推荐 v20+)
- npm 或 yarn

### 安装依赖

```bash
# 安装后端依赖
npm install
```

### 环境变量配置

在项目根目录创建 `.dev.vars` 文件（用于 Wrangler 本地开发）：

```bash
# .dev.vars
ROOT_TOKEN=root-token-123
PORT=8720
RECORD_LOG_ENABLED=false
STREAM_LOG_ENABLED=false
```

### 开发常用 Token 说明

为方便日常开发和测试，系统预设或建议使用以下 Token 进行管理操作：

| Token 类型 | 建议值 | 说明 |
|------|--------|------|
| **Root Token** | `root-token-123` | 系统最高权限。用于初次登录管理后台、创建其他管理员或普通用户。需配置在 `.dev.vars` 的 `ROOT_TOKEN` 中。 |
| **Admin Token** | `admin-token-123` | 测试环境下预设的管理员 Token。在运行后端测试（`npm run backend:test`）时，系统会自动创建一个使用此 Token 的管理员用户。 |

> **注意**：以上 Token 仅建议在**本地开发和测试环境**中使用。生产环境部署时，请务必通过 Cloudflare Workers 环境变量配置复杂的随机字符串作为 `ROOT_TOKEN`。

### 日志相关环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RECORD_LOG_ENABLED` | `false` | 是否在 `recordService` 中输出请求记录创建/更新日志，适合本地排查 |
| `STREAM_LOG_ENABLED` | `false` | 是否将流式响应原始 SSE 内容写入 `log/stream/<record.id>.log`，仅本地 Node 模式生效 |
| `LOG_DIR` | `<项目根目录>/log` | 应用日志目录，支持绝对或相对路径。Docker 部署时默认为 `/app/data/log` |

---

## 后端开发

### 启动开发服务器

#### Node 模式（本地开发）

```bash
npm run backend:dev:local
```

Node 模式使用本地 SQLite 数据库，运行在 `http://localhost:8720`，并会在后端代码变更后自动重启。

#### 前后端联合开发建议

1. **开发前端**：启动后端服务后，再启动前端开发服务器（`npm run frontend:dev`）。
2. **测试集成产物**：如果后端需要提供前端静态资源服务，必须先运行前端构建：`npm run frontend:build`。构建后的产物将被放置在 `frontend/dist/` 目录，后端会从中读取并提供服务。

#### Cloudflare Workers 模式

```bash
npm run backend:dev
```

Wrangler 会启动本地开发服务器，模拟 Cloudflare Workers 环境

### 开发命令

| 命令 | 说明 |
|------|------|
| `npm run backend:dev` | Cloudflare Workers 开发模式 |
| `npm run backend:dev:local` | Node 本地开发模式（watch 自动重启） |
| `npm run backend:start` | Node 生产模式 |
| `npm run deploy` | 部署到 Cloudflare Workers，部署前自动执行 D1 migrations，并在缺失时创建 ROOT_TOKEN |
| `npm run deploy -- --auto-create-db` | 如果当前账号下没有可用 D1，则自动创建 D1 后部署 |
| `npm run deploy:cloudflare` | 底层 Cloudflare 部署脚本；不带参数时要求 `wrangler.toml` 已配置 `database_id` |
| `npm run backend:test` | 运行后端测试 |

### 请求记录与流式日志

后端对一次 AI 请求通常会产生两类记录，它们用途不同：

1. **数据库请求记录**
   - 由 `src/service/recordService.ts` 负责创建和更新。
   - 每次请求开始时会创建一条 `record` 记录，保存 `user_id`、`model_id`、`request_data`、状态、耗时和 token 统计等。
   - 流式请求结束后，会把通过 `src/util/sseAccumulator.ts` 聚合出的完整响应写回 `response_data`。
   - 若设置 `RECORD_LOG_ENABLED=true`，`recordService` 会额外打印创建和更新日志，方便本地调试。

2. **流式原始日志文件**
   - 仅在上游返回 SSE 流式响应且 `STREAM_LOG_ENABLED=true` 时启用，逻辑位于 `src/service/senderService.ts`。
   - 服务会逐块读取上游 SSE 字节流，并将原始 chunk 追加写入本地文件：
     `log/stream/<record.id>.log`
   - 这个文件保存的是原始流内容，适合排查：
     - SSE 分帧问题
     - 上游返回的真实事件顺序
     - `usage`、`finish_reason` 等字段的实际出现位置
   - 该日志与数据库中的 `response_data` 不同：
     - `response_data` 是聚合后的完整响应
     - `log/stream/<record.id>.log` 是未聚合的原始流

#### 本地目录说明

在 Node 本地模式下，日志目录位于项目根目录（可通过 `LOG_DIR` 环境变量自定义）：

```text
log/                      # 或 LOG_DIR 指定的目录
├── app-YYYY-MM-DD.log    # 应用日志
└── stream/
    └── <record.id>.log   # 对应一次流式请求的原始 SSE 日志
```

说明：
- `record.id` 与数据库 `record` 表主键一致，可通过后台请求记录页面或接口查询后定位对应日志文件。
- 非流式请求不会生成 `log/stream/*.log` 文件。
- 如果目录不存在，服务会在首次处理流式请求时自动创建。
- Docker 部署模式下，日志默认输出到 `/app/data/log`，挂载到宿主机的 `./data/log`。

## 数据库配置与管理

### 数据库类型

| 环境 | 数据库 | 说明 |
|------|--------|------|
| **本地模式 (Node.js)** | SQLite (`better-sqlite3`) | 本地文件存储 |
| **云端模式 (Cloudflare)** | Cloudflare D1 | 分布式 SQL 数据库 |

### 数据库管理工具

项目提供 `script/db.ts` 脚本用于数据库运维，支持以下命令和环境：

#### 命令

| 命令 | 说明 |
|------|------|
| `migrate` | 执行待应用的数据库迁移 |
| `status` | 查看所有迁移文件的应用状态 |
| `clear` | 清空数据库（删除所有自定义表） |

#### 环境（`--env`）

| 环境 | 说明 |
|------|------|
| `node`（默认） | 本地 Node.js 环境，操作 `local.db` |
| `worker-local` | Wrangler 本地 D1 模拟器 |
| `worker-cloud` | Cloudflare D1 云端数据库 |

#### 使用示例

```bash
# 执行迁移（node 环境）
npm run db:migrate:node

# 查看迁移状态
npm run db:status:node

# 清空数据库
npm run db:clear:node

# 指定 worker 环境
npx tsx script/db.ts migrate --env worker-local
npx tsx script/db.ts migrate --env worker-cloud
```

### 本地模式数据库路径

在本地 Node.js 模式运行或使用 `script/db.ts` 脚本时，数据库位置遵循以下规则：

1.  **优先级 1**: 环境变量 `DB_PATH`（支持绝对路径或相对路径）。
2.  **优先级 2**: 默认为项目根目录下的 `local.db` 文件。

#### 修改数据库位置

你可以通过在 `.dev.vars` 文件中设置 `DB_PATH` 来修改位置：

```bash
# .dev.vars
DB_PATH=/path/to/your/custom.db
```

---

## 部署说明

### Cloudflare Workers 部署
有关如何将后端部署到 Cloudflare Workers 的详细步骤（包括 D1 数据库配置和一键部署），请参考专门的文档：
👉 **[Cloudflare 部署文档](deploy/CloudflareDeployment.md)**

### Docker 部署
Docker 部署相关内容已单独整理，包括 Docker Compose 部署和独立运行等。请参考专门的文档：
👉 **[Docker 部署文档](deploy/DockerDeployment.md)**

### 源码部署
如果需要在本地物理机或者私有服务器通过 Node.js 原生运行，请参考：
👉 **[源码部署文档](deploy/SourceCodeDeployment.md)**

---

## 核心架构与规范

### MVC 架构

项目遵循 MVC 架构模式：

- **Model**: `src/model/` - 数据模型和计算逻辑
- **View**: (前端部分)
- **Controller**: `src/controller/` - 处理 HTTP 请求和响应
- **Service**: `src/service/` - 核心业务逻辑

### 资源服务说明

Node 模式下，后端服务器可以提供前端构建后的静态文件：

1. **静态文件目录**：从 `frontend/dist/` 提供
2. **SPA 支持**：非 API 请求会自动回退到 `index.html`

### 开发规范

详见 `../../GEMINI.md`，核心规范如下：

1. **代码缩进**：使用 4 个空格，方法之间空两行
2. **模块划分**：
   - 业务逻辑 → service 层
   - controller 层 → 简单逻辑 + 调用 service
   - model 层 → 数据模型和计算逻辑
3. **API 风格**：REST 风格，URL 以 `.json` 结尾
4. **导出方式**：统一使用默认导出

### 添加新 API 步骤

1. **定义路由**：在 `src/routes.ts` 中添加路由
2. **创建 Controller**：在 `src/controller/` 中创建处理函数
3. **创建 Service**：在 `src/service/` 中实现业务逻辑
4. **定义 Model**（如需）：在 `src/model/` 中创建数据模型

---

## 相关文档

- **前端开发手册**：`FrontendDevManual.md`
- **测试手册**：`TestManual.md`
- **LLM API 使用指南**：`../usage/LlmApiUsage.md`
