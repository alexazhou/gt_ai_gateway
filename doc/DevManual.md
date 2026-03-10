# 开发手册

本文档描述如何进行项目开发，包括环境配置、前后端开发方式、编程规范等。

---

## 项目概览

### 技术栈

| 部分 | 技术栈 | 说明 |
|------|--------|------|
| **前端** | Vue 3 + TypeScript + Vite | 现代化前端框架 |
| **前端UI** | Ant Design Vue | 企业级 UI 组件库 |
| **前端状态管理** | Pinia | Vue 官方推荐状态管理 |
| **前端路由** | Vue Router | Vue 官方路由 |
| **前端HTTP** | Axios | HTTP 客户端 |
| **后端** | Hono + TypeScript | 轻量级 Web 框架 |
| **后端运行时** | Cloudflare Workers / Node.js | 无服务器 / 本地运行 |
| **数据库** | D1 (Cloudflare) / SQLite | 生产 / 开发环境 |
| **后端ORM** | Sutando | 统一数据库操作接口 |

### 项目结构

```
.
├── frontend/               # 前端项目
│   ├── src/
│   │   ├── api/           # API 接口定义
│   │   ├── components/    # 可复用组件
│   │   ├── composables/   # 组合式函数
│   │   ├── config/        # 配置文件
│   │   ├── router/        # 路由配置
│   │   ├── stores/        # Pinia 状态管理
│   │   ├── types/         # TypeScript 类型定义
│   │   ├── utils/         # 工具函数
│   │   └── views/         # 页面组件
│   └── package.json
├── src/                   # 后端项目
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
├── doc/                 # 文档目录
│   ├── DevManual.md     # 本文档
│   └── TestManual.md    # 测试手册
├── CLAUDE.md            # 编程规范
├── package.json         # 后端依赖
└── wrangler.toml        # Cloudflare Workers 配置
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

# 安装前端依赖
cd frontend
npm install
cd ..
```

### 环境变量配置

#### 后端环境变量

在项目根目录创建 `.dev.vars` 文件：

```bash
# .dev.vars
ROOT_TOKEN=your-admin-token-here
PORT=8787
```

#### 前端环境变量

前端环境变量位于 `frontend/` 目录下：

- `.env.development` - 开发环境配置
- `.env.production` - 生产环境配置
- `.env.example` - 配置示例

```bash
# frontend/.env.development
VITE_API_BASE_URL=http://localhost:8787
VITE_APP_TITLE=Serverless AI Gateway (Dev)
```

---

## 前端开发

### 启动前端开发服务器

```bash
npm run frontend:dev
```

前端开发服务器默认运行在 `http://localhost:5173`

### 前端开发命令

| 命令 | 说明 |
|------|------|
| `npm run frontend:dev` | 启动开发服务器（带热更新） |
| `npm run frontend:build` | 构建生产版本 |
| `npm run frontend:build:dev` | 构建开发版本 |
| `npm run frontend:dev:dev` | 开发模式（开发环境） |

### 后端地址配置

前端通过环境变量配置后端 API 地址：

#### 配置文件位置

前端环境变量位于 `frontend/` 目录下：

- `.env.development` - 开发环境配置
- `.env.production` - 生产环境配置

#### 配置说明

```bash
# frontend/.env.development - 开发环境
VITE_API_BASE_URL=http://localhost:8787
VITE_APP_TITLE=Serverless AI Gateway (Dev)

# frontend/.env.production - 生产环境
VITE_API_BASE_URL=/api
VITE_APP_TITLE=Serverless AI Gateway
```

#### 配置工作原理

1. **环境变量读取**：Vite 在构建时读取 `.env.*` 文件，以 `VITE_` 开头的变量会暴露给客户端代码
2. **Axios 配置**：前端通过 `import.meta.env.VITE_API_BASE_URL` 读取环境变量，配置到 axios 的 baseURL

```typescript
// frontend/src/utils/request.ts
const instance: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || '',  // 读取环境变量
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
});
```

#### 不同场景配置

| 场景 | VITE_API_BASE_URL 配置 | 说明 |
|------|------------------------|------|
| **本地开发（分离端口）** | `http://localhost:8787` | 前端 5173，后端 8787 |
| **本地开发（集成模式）** | `/api` | 前后端同端口，通过代理转发 |
| **生产环境** | `/api` | 前后端同源部署，使用相对路径 |

#### 修改后端地址

如需修改后端地址，编辑对应环境配置文件：

```bash
# 修改开发环境后端地址
vim frontend/.env.development

# 修改后需重启前端开发服务器
```

### 前端项目结构说明

#### API 接口 (`src/api/`)

所有 API 请求都集中在 `src/api/` 目录下，按模块组织：

```
src/api/
├── ai.ts          # AI Chat 相关 API
├── index.ts       # API 客户端配置
├── model.ts       # 模型管理 API
├── record.ts      # 请求记录 API
├── system.ts      # 系统状态 API
├── user.ts        # 用户管理 API
└── vendor.ts      # 供应商管理 API
```

#### 组件 (`src/components/`)

可复用的 Vue 组件，按功能分类：

```
src/components/
├── ai/            # AI 相关组件
├── common/        # 通用组件
└── layout/        # 布局组件
```

#### 状态管理 (`src/stores/`)

使用 Pinia 进行状态管理：

```
src/stores/
├── ai.ts          # AI 状态
├── model.ts       # 模型状态
├── record.ts      # 记录状态
├── user.ts        # 用户状态
└── vendor.ts      # 供应商状态
```

#### 类型定义 (`src/types/`)

TypeScript 类型定义：

```
src/types/
├── ai.ts          # AI 相关类型
├── index.ts       # 通用类型
├── model.ts       # 模型类型
├── record.ts      # 记录类型
├── system.ts      # 系统类型
├── user.ts        # 用户类型
└── vendor.ts      # 供应商类型
```

### 前端开发规范

1. **组件命名**：使用 PascalCase（如 `UserList.vue`）
2. **文件命名**：与组件名保持一致
3. **API 调用**：统一使用 `src/api/` 中定义的方法
4. **状态管理**：复杂状态使用 Pinia stores
5. **样式**：使用 Ant Design Vue 组件，样式统一

---

## 后端开发

### 启动后端开发服务器

#### Node 模式（本地开发）

```bash
npm run backend:dev:local
```

Node 模式使用本地 SQLite 数据库，运行在 `http://localhost:8787`

#### 前端资源服务方式

当启动后端服务器后，前端资源默认由后端服务器直接提供，具体机制如下：

1. **静态文件目录**：后端从 `frontend/dist/` 目录提供构建后的静态文件
2. **资源路径映射**：
   - `/assets/*` → 静态资源（JS、CSS）
   - `*.svg` → SVG 图标文件
   - 其他路径 → 返回 `index.html`（SPA 路由回退）
3. **SPA 路由支持**：所有非 API 请求都返回 `index.html`，由前端路由处理

```typescript
// src/local.ts - 静态文件服务配置
const distPath = join(process.cwd(), "frontend", "dist");

// 静态资源服务（JS、CSS）
app.use("/assets/*", serveStatic({ root: distPath }));

// SPA 路由回退 - 返回 index.html
app.get("*", async (c, next) => {
    // ... 跳过 API 路由
    return c.html(indexHtml, 200);
});
```

#### 前端资源更新方式

**重要说明**：Node 模式下后端服务器提供的是构建后的静态文件，**不支持热更新**。

| 场景 | 前端资源服务方式 | 热更新支持 |
|------|------------------|------------|
| **后端独立模式** | 从 `frontend/dist` 提供静态文件 | ❌ 不支持 |
| **前端开发模式** | Vite 开发服务器（端口 5173） | ✅ 支持 |

#### 开发模式推荐

**方式一：前后端分离（推荐用于前端开发）**

```bash
# 终端 1：启动后端 API 服务器
npm run backend:dev:local

# 终端 2：启动前端开发服务器（支持热更新）
npm run frontend:dev
```

访问 `http://localhost:5173`，享受 Vite 的热更新功能。

**方式二：集成模式（适用于测试部署）**

```bash
# 先构建前端
npm run frontend:build

# 再启动后端（后端会提供构建后的静态文件）
npm run backend:dev:local
```

访问 `http://localhost:8787`，但修改前端代码后需要重新构建并重启后端。

#### 热更新对比

| 特性 | 前端开发模式 | 集成模式 |
|------|-------------|---------|
| 访问地址 | `http://localhost:5173` | `http://localhost:8787` |
| 热更新 | ✅ 支持 | ❌ 不支持 |
| 资源来源 | Vite 开发服务器 | 构建后的静态文件 |
| 适用场景 | 前端开发调试 | 生产环境模拟 |

```bash
npm run backend:dev
```

Wrangler 会启动本地开发服务器，模拟 Cloudflare Workers 环境

### 后端开发命令

| 命令 | 说明 |
|------|------|
| `npm run backend:dev` | Cloudflare Workers 开发模式 |
| `npm run backend:dev:local` | Node 本地开发模式 |
| `npm run backend:start` | Node 生产模式 |
| `npm run backend:deploy` | 部署到 Cloudflare Workers |
| `npm run backend:test` | 运行后端测试 |

### 后端 MVC 架构

项目遵循 MVC 架构模式：

```
src/
├── controller/        # 控制器层 - 处理 HTTP 请求和响应
│   ├── gatewayController.ts
│   ├── userController.ts
│   ├── vendorController.ts
│   ├── modelController.ts
│   ├── recordController.ts
│   └── systemController.ts
├── service/          # 服务层 - 业务逻辑
│   ├── ormService.ts
│   ├── dbAdapter.ts
│   ├── userService.ts
│   ├── vendorService.ts
│   ├── modelService.ts
│   ├── recordService.ts
│   └── senderService.ts
├── model/           # 模型层 - 数据模型和计算逻辑
│   ├── sgUser.ts
│   ├── sgVendor.ts
│   ├── sgModel.ts
│   └── sgRecord.ts
├── middleware/      # 中间件
│   └── authMiddleware.ts
├── constants.ts     # 常量定义
└── routes.ts        # 路由配置
```

### 后端开发规范

详见 `CLAUDE.md`，核心规范如下：

1. **代码缩进**：使用 4 个空格，方法之间空两行
2. **模块划分**：
   - 业务逻辑 → service 层
   - controller 层 → 简单逻辑 + 调用 service
   - model 层 → 数据模型和计算逻辑
   - 静态方法 → utils
   - 常量 → constants
3. **API 风格**：REST 风格，URL 以 `.json` 结尾
4. **数据库查询**：不使用 `findOrFail`，使用 `find` + `if` 判断
5. **导出方式**：统一使用默认导出，调用方式：`模块名.方法名`

### 添加新 API 步骤

1. **定义路由**：在 `src/routes.ts` 中添加路由
2. **创建 Controller**：在 `src/controller/` 中创建处理函数
3. **创建 Service**：在 `src/service/` 中实现业务逻辑
4. **定义 Model**（如需）：在 `src/model/` 中创建数据模型

#### 示例：添加用户列表 API

```typescript
// 1. src/routes.ts
app.get("/user/list.json", userController.list);

// 2. src/controller/userController.ts
import userService from "../service/userService";

export async function list(c: Context) {
    const users = await userService.list();
    return c.json(users);
}

// 3. src/service/userService.ts
import UserModel from "../model/sgUser";

export async function list() {
    const users = await UserModel.all();
    return users;
}
```

---

## 开发工作流

### 同时开发前后端

推荐同时启动前后端开发服务器：

```bash
# 终端 1：启动后端
npm run backend:dev:local

# 终端 2：启动前端
npm run frontend:dev
```

访问 `http://localhost:5173` 进行开发

### 数据库迁移

```bash
# 执行迁移
npm run db:migrate:local

# 查看迁移状态
npm run db:status:local

# 清空数据库
npm run db:clear:local
```

### 运行测试

```bash
# 运行所有测试
npm run backend:test

# 运行特定测试
npm run backend:test -- --run tests/api/user/user.test.ts
```

详见 `doc/TestManual.md`

---

## 常见问题

### 前端

**Q: 前端无法连接后端 API？**

A: 检查 `frontend/.env.development` 中的 `VITE_API_BASE_URL` 是否正确配置

**Q: 热更新不生效？**

A: 重启前端开发服务器

### 后端

**Q: 启动时 ROOT_TOKEN 为空？**

A: 检查 `.dev.vars` 文件是否存在且配置正确

**Q: 数据库连接失败？**

A: 运行 `npm run db:migrate:local` 初始化数据库

### 开发流程

**Q: 如何添加新页面？**

A:
1. 在 `frontend/src/views/` 创建页面组件
2. 在 `frontend/src/router/` 添加路由配置
3. 在 `frontend/src/api/` 添加 API 接口（如需）

**Q: 如何添加后端 API？**

A:
1. 在 `src/routes.ts` 添加路由
2. 在 `src/controller/` 添加控制器
3. 在 `src/service/` 添加服务层逻辑

---

## 相关文档

- **测试手册**：`doc/TestManual.md`
- **编程规范**：`CLAUDE.md`
- **本地运行**：`LOCAL.md`
- **项目 README**：`README.md`