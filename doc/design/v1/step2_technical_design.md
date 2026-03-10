# v1.x - MVP 技术实现方案（v1.0 + v1.1）

## 一、技术栈确认

### 1.1 核心技术
| 技术 | 版本 | 用途 |
|------|------|------|
| Vue | 3.4+ | 前端框架 |
| TypeScript | 5.0+ | 类型系统 |
| Vite | 5.0+ | 构建工具 |
| Ant Design Vue | 4.x | UI 组件库 |
| Vue Router | 4.x | 路由管理 |
| Pinia | 2.x | 状态管理 |
| Axios | 1.x | HTTP 请求 |

### 1.2 辅助库
| 库 | 用途 |
|------|------|
| Day.js | 日期时间处理 |
| lodash-es | 工具函数 |
| VueUse | Vue 组合式工具库 |

---

## 二、项目结构

```
frontend/
├── public/                 # 静态资源
├── src/
│   ├── api/               # API 请求模块
│   │   ├── index.ts       # API 基础配置
│   │   ├── user.ts        # 用户相关 API
│   │   ├── vendor.ts      # 供应商相关 API
│   │   ├── model.ts       # 模型相关 API
│   │   └── system.ts      # 系统相关 API
│   ├── assets/            # 资源文件
│   ├── components/        # 公共组件
│   │   ├── layout/       # 布局组件
│   │   │   ├── AppLayout.vue      # 主布局
│   │   │   ├── AppHeader.vue      # 头部导航
│   │   │   └── AppSidebar.vue     # 侧边栏
│   │   └── common/       # 通用组件
│   │       ├── TokenDisplay.vue    # Token 显示/隐藏组件
│   │       └── StatusCard.vue     # 状态卡片
│   ├── composables/       # 组合式函数
│   │   ├── useAuth.ts    # 认证相关
│   │   └── useTable.ts   # 表格通用逻辑
│   ├── config/            # 配置文件
│   │   └── index.ts       # 环境配置
│   ├── router/            # 路由配置
│   │   └── index.ts
│   ├── stores/            # Pinia 状态管理
│   │   ├── auth.ts       # 认证状态
│   │   └── app.ts        # 应用状态
│   ├── types/             # TypeScript 类型定义
│   │   ├── user.ts       # 用户类型
│   │   ├── vendor.ts     # 供应商类型
│   │   ├── model.ts      # 模型类型
│   │   └── index.ts      # 通用类型
│   ├── utils/             # 工具函数
│   │   ├── request.ts    # Axios 封装
│   │   ├── validator.ts  # 表单验证
│   │   └── format.ts     # 数据格式化
│   ├── views/             # 页面视图
│   │   ├── Login.vue     # 登录页
│   │   ├── Dashboard.vue # 仪表盘
│   │   ├── User/        # 用户管理
│   │   │   ├── Index.vue
│   │   │   ├── List.vue
│   │   │   └── Detail.vue
│   │   ├── Vendor/      # 供应商管理
│   │   │   ├── Index.vue
│   │   │   ├── List.vue
│   │   │   └── Detail.vue
│   │   └── Model/       # 模型管理
│   │       ├── Index.vue
│   │       ├── List.vue
│   │       └── Detail.vue
│   ├── App.vue           # 根组件
│   └── main.ts           # 入口文件
├── .env.example          # 环境变量示例
├── .env.development      # 开发环境配置
├── .env.production       # 生产环境配置
├── index.html            # HTML 模板
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 三、类型定义

### 3.1 通用类型（src/types/index.ts）

| 接口名 | 用途 | 关键字段 |
|--------|------|----------|
| `BaseResponse<T>` | 通用响应结构 | 动态键值对 |
| `PaginationParams` | 分页参数 | page, pageSize |
| `TableQuery` | 表格查询条件 | keyword + 分页参数 |
| `BaseEntity` | 实体基础字段 | id, created_at, updated_at |

### 3.2 用户类型（src/types/user.ts）

| 类型/接口 | 用途 | 关键字段 |
|-----------|------|----------|
| `UserType` | 用户类型枚举 | 'normal' \| 'admin' |
| `User` | 用户实体 | name, token, type |
| `CreateUserRequest` | 创建用户请求 | name, token?, type? |
| `UserQuery` | 用户查询条件 | type? + TableQuery |

### 3.3 供应商类型（src/types/vendor.ts）

| 类型/接口 | 用途 | 关键字段 |
|-----------|------|----------|
| `VendorType` | 供应商类型枚举 | 'openai' \| 'anthropic' \| 'aliyun' \| ... |
| `VendorUrls` | URL 配置 | 动态键值对 |
| `Vendor` | 供应商实体 | type, name, token, urls |
| `CreateVendorRequest` | 创建供应商请求 | type, name, token, urls? |
| `UpdateVendorRequest` | 更新供应商请求 | 可选字段 |
| `VendorQuery` | 供应商查询条件 | type?, format? + TableQuery |

### 3.4 模型类型（src/types/model.ts）

| 类型/接口 | 用途 | 关键字段 |
|-----------|------|----------|
| `Model` | 模型实体 | name, vendor_id, enable |
| `CreateModelRequest` | 创建模型请求 | name, vendor_id, enable? |
| `UpdateModelRequest` | 更新模型请求 | 可选字段 |
| `ModelQuery` | 模型查询条件 | vendor_id? + TableQuery |

---

## 四、API 模块接口

### 4.1 HTTP 请求封装（src/utils/request.ts）

| 功能 | 说明 |
|------|------|
| Axios 实例 | 创建配置好的 axios 实例，包含 baseURL、timeout、headers |
| 请求拦截器 | 从 localStorage 获取 Token，添加到 Authorization 请求头 |
| 响应拦截器 | 统一错误处理，根据状态码显示对应错误消息，401 时跳转登录页 |

### 4.2 用户 API 模块（src/api/user.ts）

| 函数名 | 请求方法 | 接口路径 | 参数 | 返回值 |
|--------|----------|----------|------|--------|
| `listUsers` | GET | /user/list.json | query?: UserQuery | User[] |
| `getUser` | GET | /user/{id} | id: number | User |
| `createUser` | POST | /user/create.json | data: CreateUserRequest | User |
| `updateUser` | PUT | /user/{id} | id: number, data: Partial<CreateUserRequest> | User |
| `deleteUser` | DELETE | /user/{id} | id: number | void |

### 4.3 供应商 API 模块（src/api/vendor.ts）

| 函数名 | 请求方法 | 接口路径 | 参数 | 返回值 |
|--------|----------|----------|------|--------|
| `listVendors` | GET | /vendor/list.json | query?: VendorQuery | Vendor[] |
| `getVendor` | GET | /vendor/{id} | id: number | Vendor |
| `createVendor` | POST | /vendor/create.json | data: CreateVendorRequest | Vendor |
| `updateVendor` | PUT | /vendor/{id} | id: number, data: UpdateVendorRequest | Vendor |
| `deleteVendor` | DELETE | /vendor/{id} | id: number | void |

### 4.4 模型 API 模块（src/api/model.ts）

| 函数名 | 请求方法 | 接口路径 | 参数 | 返回值 |
|--------|----------|----------|------|--------|
| `listModels` | GET | /model/list.json | query?: ModelQuery | Model[] |
| `getModel` | GET | /model/{id} | id: number | Model |
| `createModel` | POST | /model/create.json | data: CreateModelRequest | Model |
| `updateModel` | PUT | /model/{id} | id: number, data: UpdateModelRequest | Model |
| `deleteModel` | DELETE | /model/{id} | id: number | void |

### 4.5 系统 API 模块（src/api/system.ts）

| 函数名 | 请求方法 | 接口路径 | 参数 | 返回值 |
|--------|----------|----------|------|--------|
| `welcome` | GET | / | - | any |
| `status` | GET | /status.json | - | any |

---

## 五、状态管理（Pinia）

### 5.1 认证状态（src/stores/auth.ts）

**Store 名称**: `auth`

**State**:
| 字段名 | 类型 | 说明 |
|--------|------|------|
| `token` | Ref<string> | 用户认证 Token |
| `isLoading` | Ref<boolean> | 认证状态加载中 |

**Getters**:
| 名称 | 返回类型 | 说明 |
|------|----------|------|
| `isAuthenticated` | Computed<boolean> | 是否已认证（根据 token 是否存在） |

**Actions**:
| 方法名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `setToken` | newToken: string | void | 设置 Token 并保存到 localStorage |
| `clearToken` | - | void | 清除 Token 和 localStorage |
| `validateToken` | - | Promise<boolean> | 验证 Token 有效性（调用 welcome 接口） |
| `login` | newToken: string | Promise<boolean> | 登录：设置 Token 并验证 |
| `logout` | - | void | 登出：清除 Token |

### 5.2 应用状态（src/stores/app.ts）

**Store 名称**: `app`

**State**:
| 字段名 | 类型 | 说明 |
|--------|------|------|
| `sidebarCollapsed` | Ref<boolean> | 侧边栏折叠状态 |

**Actions**:
| 方法名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `toggleSidebar` | - | void | 切换侧边栏折叠状态 |

---

## 六、路由配置（src/router/index.ts）

### 6.1 路由表结构

| 路径 | 名称 | 组件 | 元信息 | 说明 |
|------|------|------|--------|------|
| /login | Login | Login.vue | requiresAuth: false | 登录页（无需认证） |
| / | Layout | AppLayout.vue | requiresAuth: true | 主布局（需要认证） |
| /dashboard | Dashboard | Dashboard.vue | title: '仪表盘' | 仪表盘 |
| /user | User | User/Index.vue | title: '用户管理' | 用户管理入口 |
| /user | UserList | User/List.vue | - | 用户列表 |
| /user/:id | UserDetail | User/Detail.vue | - | 用户详情 |
| /vendor | Vendor | Vendor/Index.vue | title: '供应商管理' | 供应商管理入口 |
| /vendor | VendorList | Vendor/List.vue | - | 供应商列表 |
| /vendor/:id | VendorDetail | Vendor/Detail.vue | - | 供应商详情 |
| /model | Model | Model/Index.vue | title: '模型管理' | 模型管理入口 |
| /model | ModelList | Model/List.vue | - | 模型列表 |
| /model/:id | ModelDetail | Model/Detail.vue | - | 模型详情 |

### 6.2 路由守卫逻辑

- **需要认证的路由**: 检查 `isAuthenticated`，未登录则跳转登录页并记录重定向路径
- **登录页访问控制**: 已登录用户访问登录页时，自动跳转到仪表盘

---

## 七、公共组件接口

### 7.1 TokenDisplay 组件（src/components/common/TokenDisplay.vue）

**Props**:
| 属性名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `token` | string | 是 | 要显示的 Token 字符串 |

**功能**:
- 默认显示 Token 的遮罩形式（前4位...后4位）
- 点击"显示/隐藏"按钮切换明文/遮罩显示
- 点击"复制"按钮复制完整 Token 到剪贴板

### 7.2 StatusCard 组件（src/components/common/StatusCard.vue）

**Props**:
| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `title` | string | 是 | - | 卡片标题 |
| `value` | string \| number | 是 | - | 显示值 |
| `description` | string | 否 | - | 描述文本 |
| `loading` | boolean | 否 | false | 加载状态 |

---

## 八、组合式函数接口

### 8.1 useTable（src/composables/useTable.ts）

**参数**:
| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `defaultPageSize` | number | 10 | 默认每页条数 |

**返回值**:
| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `loading` | Ref<boolean> | 加载状态 |
| `data` | Ref<T[]> | 表格数据 |
| `total` | Ref<number> | 总条数 |
| `pagination` | Reactive<object> | 分页配置对象 |
| `searchForm` | Reactive<Record<string, any>> | 搜索表单数据 |
| `setPage` | (page: number, pageSize?: number) => void | 设置页码 |
| `resetSearch` | () => void | 重置搜索条件 |

### 8.2 useAuth（src/composables/useAuth.ts）

**返回值**:
| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `token` | Computed<string> | 当前 Token |
| `isAuthenticated` | Computed<boolean> | 是否已认证 |
| `login` | (token: string) => Promise<boolean> | 登录方法 |
| `logout` | () => void | 登出方法 |

---

## 九、环境变量配置

### 9.1 环境变量列表

| 变量名 | 用途 | 示例值 |
|--------|------|--------|
| `VITE_API_BASE_URL` | API 基础 URL | http://localhost:8787 |
| `VITE_APP_TITLE` | 应用标题 | Serverless AI Gateway |

### 9.2 配置文件

- `.env.example`: 环境变量模板（提交到版本控制）
- `.env.development`: 开发环境配置
- `.env.production`: 生产环境配置

---

## 十、项目初始化

### 10.1 创建项目命令

```bash
# 创建 Vite + Vue 3 + TypeScript 项目
npm create vite@latest frontend -- --template vue-ts

cd frontend

# 安装核心依赖
npm install ant-design-vue vue-router pinia axios dayjs lodash-es @vueuse/core

# 安装类型定义
npm install -D @types/lodash-es
```

### 10.2 目录创建命令

```bash
mkdir -p src/api src/components/layout src/components/common src/composables src/config src/router src/stores src/types src/utils src/views/User src/views/Vendor src/views/Model
```

---

*文档版本：v1.0*
*创建日期：2026-03-07*
