# v1.x - 开发任务清单（v1.0 + v1.1）

## 任务说明

本文档将 v1.x（v1.0 + v1.1）的开发工作分解为具体可执行的任务，按开发先后顺序排列。

---

## 任务列表

### Phase 1: 项目初始化和基础配置

#### Task 1.1 - 创建 Vue 3 + TypeScript + Vite 项目
- **描述**: 使用 Vite 创建 Vue 3 + TypeScript 项目模板
- **命令**: `npm create vite@latest frontend -- --template vue-ts`
- **文件**: `frontend/` 目录结构
- **预估时间**: 5 分钟
- **优先级**: P0

#### Task 1.2 - 安装项目依赖
- **描述**: 安装所有必需的 npm 包
- **命令**:
  ```bash
  npm install ant-design-vue vue-router pinia axios dayjs lodash-es @vueuse/core
  npm install -D @types/lodash-es
  ```
- **文件**: `frontend/package.json`
- **预估时间**: 2 分钟
- **优先级**: P0
- **依赖**: Task 1.1

#### Task 1.3 - 配置 TypeScript 和 Vite
- **描述**: 配置 TypeScript 编译选项和 Vite 构建配置
- **文件**:
  - `frontend/tsconfig.json`
  - `frontend/vite.config.ts`
  - `frontend/tsconfig.node.json`
- **预估时间**: 10 分钟
- **优先级**: P0
- **依赖**: Task 1.1

#### Task 1.4 - 创建环境变量配置文件
- **描述**: 创建 .env 文件和环境变量示例
- **文件**:
  - `frontend/.env.example`
  - `frontend/.env.development`
  - `frontend/.env.production`
- **预估时间**: 5 分钟
- **优先级**: P0
- **依赖**: Task 1.1

#### Task 1.5 - 创建项目目录结构
- **描述**: 创建所有必需的目录和空文件
- **文件**:
  - `frontend/src/api/`
  - `frontend/src/components/layout/`
  - `frontend/src/components/common/`
  - `frontend/src/composables/`
  - `frontend/src/config/`
  - `frontend/src/router/`
  - `frontend/src/stores/`
  - `frontend/src/types/`
  - `frontend/src/utils/`
  - `frontend/src/views/`
- **预估时间**: 5 分钟
- **优先级**: P0
- **依赖**: Task 1.1

---

### Phase 2: 类型定义

#### Task 2.1 - 创建通用类型定义
- **描述**: 定义通用的 TypeScript 类型
- **文件**: `frontend/src/types/index.ts`
- **内容**: BaseResponse、PaginationParams、TableQuery、BaseEntity
- **预估时间**: 10 分钟
- **优先级**: P0
- **依赖**: Task 1.5

#### Task 2.2 - 创建用户类型定义
- **描述**: 定义用户相关的 TypeScript 类型
- **文件**: `frontend/src/types/user.ts`
- **内容**: User、CreateUserRequest、UserQuery、UserType
- **预估时间**: 10 分钟
- **优先级**: P0
- **依赖**: Task 2.1

#### Task 2.3 - 创建供应商类型定义
- **描述**: 定义供应商相关的 TypeScript 类型
- **文件**: `frontend/src/types/vendor.ts`
- **内容**: Vendor、CreateVendorRequest、UpdateVendorRequest、VendorQuery、VendorType、ApiFormat、VendorUrls
- **预估时间**: 15 分钟
- **优先级**: P0
- **依赖**: Task 2.1

#### Task 2.4 - 创建模型类型定义
- **描述**: 定义模型相关的 TypeScript 类型
- **文件**: `frontend/src/types/model.ts`
- **内容**: Model、CreateModelRequest、UpdateModelRequest、ModelQuery
- **预估时间**: 10 分钟
- **优先级**: P0
- **依赖**: Task 2.1

---

### Phase 3: 工具函数和配置

#### Task 3.1 - 创建 Axios 请求封装
- **描述**: 封装 Axios，添加请求/响应拦截器
- **文件**: `frontend/src/utils/request.ts`
- **内容**: Axios 实例创建、请求拦截器（添加 Token）、响应拦截器（统一错误处理）
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 1.2, Task 1.4

#### Task 3.2 - 创建表单验证工具
- **描述**: 创建通用的表单验证函数
- **文件**: `frontend/src/utils/validator.ts`
- **内容**: 表单验证规则和验证函数
- **预估时间**: 20 分钟
- **优先级**: P1
- **依赖**: Task 3.1

#### Task 3.3 - 创建数据格式化工具
- **描述**: 创建数据格式化工具函数
- **文件**: `frontend/src/utils/format.ts`
- **内容**: 日期格式化、Token 遮罩等格式化函数
- **预估时间**: 20 分钟
- **优先级**: P1
- **依赖**: Task 3.1

#### Task 3.4 - 创建应用配置文件
- **描述**: 创建应用配置文件
- **文件**: `frontend/src/config/index.ts`
- **内容**: 环境变量读取和配置导出
- **预估时间**: 10 分钟
- **优先级**: P0
- **依赖**: Task 1.4

---

### Phase 4: API 模块

#### Task 4.1 - 创建系统 API 模块
- **描述**: 创建系统相关的 API 请求函数
- **文件**: `frontend/src/api/system.ts`
- **内容**: welcome()、status() 函数
- **预估时间**: 15 分钟
- **优先级**: P0
- **依赖**: Task 3.1

#### Task 4.2 - 创建用户 API 模块
- **描述**: 创建用户相关的 API 请求函数
- **文件**: `frontend/src/api/user.ts`
- **内容**: listUsers()、getUser()、createUser() 函数
- **预估时间**: 20 分钟
- **优先级**: P0
- **依赖**: Task 2.2, Task 3.1

#### Task 4.3 - 创建供应商 API 模块
- **描述**: 创建供应商相关的 API 请求函数
- **文件**: `frontend/src/api/vendor.ts`
- **内容**: listVendors()、getVendor()、createVendor()、updateVendor() 函数
- **预估时间**: 20 分钟
- **优先级**: P0
- **依赖**: Task 2.3, Task 3.1

#### Task 4.4 - 创建模型 API 模块
- **描述**: 创建模型相关的 API 请求函数
- **文件**: `frontend/src/api/model.ts`
- **内容**: listModels()、getModel()、createModel()、updateModel() 函数
- **预估时间**: 20 分钟
- **优先级**: P0
- **依赖**: Task 2.4, Task 3.1

#### Task 4.5 - 创建 API 索引文件
- **描述**: 导出所有 API 模块
- **文件**: `frontend/src/api/index.ts`
- **内容**: 导出所有 API 函数
- **预估时间**: 5 分钟
- **优先级**: P0
- **依赖**: Task 4.1, Task 4.2, Task 4.3, Task 4.4

---

### Phase 5: 状态管理

#### Task 5.1 - 创建认证状态 Store
- **描述**: 创建 Pinia 认证状态管理
- **文件**: `frontend/src/stores/auth.ts`
- **内容**: token、isAuthenticated、login()、logout()、validateToken() 函数
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 4.1

#### Task 5.2 - 创建应用状态 Store
- **描述**: 创建 Pinia 应用状态管理
- **文件**: `frontend/src/stores/app.ts`
- **内容**: sidebarCollapsed、toggleSidebar() 函数
- **预估时间**: 15 分钟
- **优先级**: P1
- **依赖**: 无

---

### Phase 6: 组合式函数

#### Task 6.1 - 创建 useTable 组合式函数
- **描述**: 创建表格通用逻辑的组合式函数
- **文件**: `frontend/src/composables/useTable.ts`
- **内容**: loading、data、pagination、searchForm 等
- **预估时间**: 20 分钟
- **优先级**: P0
- **依赖**: 无

#### Task 6.2 - 创建 useAuth 组合式函数
- **描述**: 创建认证相关的组合式函数
- **文件**: `frontend/src/composables/useAuth.ts`
- **内容**: 基于 authStore 的便捷函数
- **预估时间**: 15 分钟
- **优先级**: P1
- **依赖**: Task 5.1

---

### Phase 7: 公共组件

#### Task 7.1 - 创建 TokenDisplay 组件
- **描述**: 创建 Token 显示/隐藏组件
- **文件**: `frontend/src/components/common/TokenDisplay.vue`
- **功能**: Token 遮罩、显示/隐藏切换、复制功能
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 3.3

#### Task 7.2 - 创建 StatusCard 组件
- **描述**: 创建状态卡片组件
- **文件**: `frontend/src/components/common/StatusCard.vue`
- **功能**: 显示统计数据的卡片
- **预估时间**: 20 分钟
- **优先级**: P1
- **依赖**: 无

---

### Phase 8: 路由配置

#### Task 8.1 - 创建路由配置
- **描述**: 配置 Vue Router 和路由守卫
- **文件**: `frontend/src/router/index.ts`
- **内容**: 路由定义、认证守卫
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 5.1

---

### Phase 9: 登录页面

#### Task 9.1 - 创建登录页面
- **描述**: 创建登录表单页面
- **文件**: `frontend/src/views/Login.vue`
- **功能**: Token 输入、登录验证、错误提示
- **预估时间**: 45 分钟
- **优先级**: P0
- **依赖**: Task 5.1, Task 8.1

---

### Phase 10: 布局组件

#### Task 10.1 - 创建主布局组件
- **描述**: 创建主布局框架
- **文件**: `frontend/src/components/layout/AppLayout.vue`
- **功能**: 侧边栏栏、主内容区域
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 5.2

#### Task 10.2 - 创建头部导航组件
- **描述**: 创建顶部导航栏
- **文件**: `frontend/src/components/layout/AppHeader.vue`
- **功能**: Logo、用户信息、登出按钮
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 5.1

#### Task 10.3 - 创建侧边栏组件
- **描述**: 创建侧边栏导航菜单
- **文件**: `frontend/src/components/layout/AppSidebar.vue`
- **功能**: 菜单导航、折叠功能
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 8.1

---

### Phase 11: 用户管理功能

#### Task 11.1 - 创建用户列表页面
- **描述**: 创建用户列表和表格
- **文件**: `frontend/src/views/User/List.vue`
- **功能**: 用户表格、搜索、筛选、分页
- **预估时间**: 60 分钟
- **优先级**: P0
- **依赖**: Task 4.2, Task 6.1, Task 8.1

#### Task 11.2 - 创建用户新建对话框
- **描述**: 创建新建用户表单对话框
- **文件**: `frontend/src/views/User/DialogCreate.vue`
- **功能**: 用户名、Token、类型选择、表单验证
- **预估时间**: 40 分钟
- **优先级**: P0
- **依赖**: Task 4.2

#### Task 11.3 - 创建用户详情页面
- **描述**: 创建用户详情查看
- **文件**: `frontend/src/views/User/Detail.vue`
- **功能**: 用户信息展示、Token 显示
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 4.2, Task 7.1

#### Task 11.4 - 创建用户管理 Index 页面
- **描述**: 创建用户管理入口页面
- **文件**: `frontend/src/views/User/Index.vue`
- **功能**: 包含用户列表和操作
- **预估时间**: 20 分钟
- **优先级**: P0
- **依赖**: Task 11.1, Task 11.2

---

### Phase 12: 供应商管理功能

#### Task 12.1 - 创建供应商列表页面
- **描述**: 创建供应商列表和表格
- **文件**: `frontend/src/views/Vendor/List.vue`
- **功能**: 供应商表格、搜索、筛选、分页
- **预估时间**: 60 分钟
- **优先级**: P0
- **依赖**: Task 4.3, Task 6.1

#### Task 12.2 - 创建供应商新建对话框
- **描述**: 创建新建供应商表单对话框
- **文件**: `frontend/src/views/Vendor/DialogCreate.vue`
- **功能**: 类型、名称、Token、URLs 配置
- **预估时间**: 50 分钟
- **优先级**: P0
- **依赖**: Task 4.3

#### Task 12.3 - 创建供应商编辑对话框
- **描述**: 创建编辑供应商表单对话框
- **文件**: `frontend/src/views/Vendor/DialogEdit.vue`
- **功能**: 预填充现有数据、更新功能
- **预估时间**: 45 分钟
- **优先级**: P0
- **依赖**: Task 4.3

#### Task 12.4 - 创建供应商详情页面
- **描述**: 创建供应商详情查看
- **文件**: `frontend/src/views/Vendor/Detail.vue`
- **功能**: 供应商信息展示、Token 显示
- **预估时间**: 30 分钟
- **优先级**: P0
- **依赖**: Task 4.3, Task 7.1

#### Task 12.5 - 创建供应商管理 Index 页面
- **描述**: 创建供应商管理入口页面
- **文件**: `frontend/src/views/Vendor/Index.vue`
- **功能**: 包含供应商列表和操作
- **预估时间**: 20 分钟
- **优先级**: P0
- **依赖**: Task 12.1, Task 12.2, Task 12.3

---

### Phase 13: 模型管理功能

#### Task 13.1 - 创建模型列表页面
- **描述**: 创建模型列表和表格
- **文件**: `frontend/src/views/Model/List.vue`
- **功能**: 模型表格、搜索、筛选、分页
- **预估时间**: 60 分钟
- **优先级**: P0
- **依赖**: Task 4.4, Task 4.3, Task 6.1

#### Task 13.2 - 创建模型新建对话框
- **描述**: 创建新建模型表单对话框
- **文件**: `frontend/src/views/Model/DialogCreate.vue`
- **功能**: 模型名称、供应商选择、启用状态
- **预估时间**: 40 分钟
- **优先级**: P0
- **依赖**: Task 4.3, Task 4.4

#### Task 13.3 - 创建模型编辑对话框
- **描述**: 创建编辑模型表单对话框
- **文件**: `frontend/src/views/Model/DialogEdit.vue`
- **功能**: 预填充现有数据、更新功能
- **预估时间**: 40 分钟
- **优先级**: P0
- **依赖**: Task 4.4

#### Task 13.4 - 创建模型详情页面
- **描述**: 创建模型详情查看
- **文件**: `frontend/src/views/Model/Detail.vue`
- **功能**: 模型信息展示
- **预估时间**: 25 分钟
- **优先级**: P0
- **依赖**: Task 4.4

#### Task 13.5 - 创建模型管理 Index 页面
- **描述**: 创建模型管理入口页面
- **文件**: `frontend/src/views/Model/Index.vue`
- **功能**: 包含模型列表和操作
- **预估时间**: 20 分钟
- **优先级**: P0
- **依赖**: Task 13.1, Task 13.2, Task 13.3

---

### Phase 14: 仪表盘

#### Task 14.1 - 创建仪表盘页面
- **描述**: 创建系统仪表盘
- **文件**: `frontend/src/views/Dashboard.vue`
- **功能**: 系统状态、统计卡片
- **预估时间**: 45 分钟
- **优先级**: P0
- **依赖**: Task 4.1, Task 7.2

---

### Phase 15: 集成和测试

#### Task 15.1 - 配置主入口文件
- **描述**: 配置 main.ts 和 App.vue
- **文件**:
  - `frontend/src/main.ts`
  - `frontend/src/App.vue`
- **功能**: 注册插件、应用挂载
- **预估时间**: 15 分钟
- **优先级**: P0
- **依赖**: Task 8.1

#### Task 15.2 - 功能测试和 Bug 修复
- **描述**: 测试所有功能并修复问题
- **测试内容**:
  - 登录/登出流程
  - 用户 CRUD 操作
  - 供应商 CRUD 操作
  - 模型 CRUD 操作
  - 表单验证
  - 错误处理
- **预估时间**: 120 分钟
- **优先级**: P0
- **依赖**: 所有前置任务

#### Task 15.3 - 代码优化和清理
- **描述**: 优化代码质量、清理未使用代码
- **优化内容**:
  - 删除未使用的导入
  - 优化组件性能
  - 改善代码可读性
- **预估时间**: 60 分钟
- **优先级**: P1
- **依赖**: Task 15.2

---

## 任务统计

| Phase | 任务数量 | 预估总时间 |
|-------|---------|-----------|
| Phase 1: 项目初始化 | 5 | 27 分钟 |
| Phase 2: 类型定义 | 4 | 45 分钟 |
| Phase 3: 工具函数 | 4 | 80 分钟 |
| Phase 4: API 模块 | 5 | 80 分钟 |
| Phase 5: 状态管理 | 2 | 45 分钟 |
| Phase 6: 组合式函数 | 2 | 35 分钟 |
| Phase 7: 公共组件 | 2 | 50 分钟 |
| Phase 8: 路由配置 | 1 | 30 分钟 |
| Phase 9: 登录页面 | 1 | 45 分钟 |
| Phase 10: 布局组件 | 3 | 90 分钟 |
| Phase 11: 用户管理 | 4 | 150 分钟 |
| Phase 12: 供应商管理 | 5 | 205 分钟 |
| Phase 13: 模型管理 | 5 | 185 分钟 |
| Phase 14: 仪表盘 | 1 | 45 分钟 |
| Phase 15: 集成测试 | 3 | 200 分钟 |
| **总计** | **42** | **约 20 小时** |

---

## 优先级说明

| 优先级 | 说明 |
|--------|------|
| P0 | 必须完成，阻塞发布 |
| P1 | 重要功能，尽量完成 |

---

## 开发建议

1. **按顺序执行**: 严格按照依赖关系执行任务
2. **每日验收**: 每个 Phase 完成后进行自测验收
3. **代码评审**: 核心模块完成后进行代码评审
4. **测试驱动**: 在开发 UI 前先确保 API 正常工作
5. **持续集成**: 每完成一个功能提交一次代码

---

*文档版本：v1.0*
*创建日期：2026-03-07*