# 前端开发手册

本文档描述如何进行前端项目开发，包括环境配置、前端开发方式、编程规范等。

---

## 前端技术栈

| 部分 | 技术栈 | 说明 |
|------|--------|------|
| **前端框架** | Vue 3 + TypeScript + Vite | 现代化前端框架 |
| **UI 组件库** | Ant Design Vue | 企业级 UI 组件库 |
| **状态管理** | Pinia | Vue 官方推荐状态管理 |
| **路由** | Vue Router | Vue 官方路由 |
| **HTTP 客户端** | Axios | 异步请求处理 |

## 前端项目结构

```
frontend/               # 前端项目根目录
├── src/
│   ├── api/           # API 接口定义
│   ├── components/    # 可复用组件
│   ├── composables/   # 组合式函数
│   ├── config/        # 配置文件
│   ├── router/        # 路由配置
│   ├── stores/        # Pinia 状态管理
│   ├── types/         # TypeScript 类型定义
│   ├── utils/         # 工具函数
│   └── views/         # 页面组件
└── package.json
```

---

## 环境配置

### 前置要求

- Node.js (推荐 v20+)
- npm 或 yarn

### 安装依赖

```bash
cd frontend
npm install
```

### 环境变量配置

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

### 启动开发服务器

> **注意**：在开发前端之前，需要先启动后端开发服务器（或在 `.env.development` 中配置其他可用的 API 服务器地址）。

```bash
# 启动前端开发服务器
npm run frontend:dev
```

前端开发服务器默认运行在 `http://localhost:5173`

### 前后端联合开发

1. **前端开发**：需先启动后端（`npm run backend:dev:local`，后端代码变更会自动重启），再启动前端（`npm run frontend:dev`）。
2. **后端测试前端产物**：如果开发后端时需要用到前端产物（如测试后端集成的静态资源服务），需要先运行前端构建：`npm run frontend:build`。

### 开发命令

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

### 项目结构说明

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

### 异常处理规范

项目后端引入了统一的异常处理机制，前端及后端业务逻辑均需遵循以下规范：

#### AppError 机制

后端定义了 `customError.AppError` 类，用于抛出可预期的业务异常。

1.  **统一返回格式**：当后端抛出 `AppError` 时，全局错误处理器会将其捕获并转换为统一的 JSON 格式返回给前端。
2.  **状态码约定**：
    *   **400 (Bad Request)**: 用于通用的业务逻辑错误（如参数错误、配置缺失等）。
    *   **401 (Unauthorized)**: 身份验证失败。
    *   **403 (Forbidden)**: 权限不足。
    *   **404 (Not Found)**: 资源不存在。
    *   **409 (Conflict)**: 资源冲突（如名称重复）。
    *   **500 (Internal Server Error)**: 用于未捕获的系统崩溃或严重错误。

#### 业务异常处理要求

在编写后端业务逻辑（Service/Model/Controller）时：
*   **严禁直接抛出原生 `Error`**：原生 `Error` 会被视为系统崩溃，导致接口返回 500 错误且不包含友好的提示信息。
*   **必须抛出 `AppError`**：当遇到业务逻辑不符的情况时，必须使用 `throw new customError.AppError('错误信息', 状态码)`。

#### 前端处理建议

前端 `src/utils/request.ts` 已集成了响应拦截器：
*   对于 `400` 等业务异常，拦截器会自动从返回的 JSON 中提取 `message` 并通过 Ant Design 的 `message.error` 进行全局提示。
*   开发者在页面逻辑中只需关注正常的 `try-catch` 或 `.catch()` 流程即可。

### 开发规范

详见 `GEMINI.md`，核心规范如下：

1. **组件命名**：使用 PascalCase（如 `UserList.vue`）
2. **文件命名**：与组件名保持一致
3. **API 调用**：统一使用 `src/api/` 中定义的方法
4. **状态管理**：复杂状态使用 Pinia stores
5. **样式**：使用 Ant Design Vue 组件，样式统一

---

## 常见问题

**Q: 前端无法连接后端 API？**

A: 检查 `frontend/.env.development` 中的 `VITE_API_BASE_URL` 是否正确配置

**Q: 热更新不生效？**

A: 重启前端开发服务器

**Q: 如何添加新页面？**

A:
1. 在 `frontend/src/views/` 创建页面组件
2. 在 `frontend/src/router/` 添加路由配置
3. 在 `frontend/src/api/` 添加 API 接口（如需）

---

## 相关文档

- **后端开发手册**：`doc/BackendDevManual.md`
- **测试手册**：`doc/TestManual.md`
- **编程规范**：`GEMINI.md`
