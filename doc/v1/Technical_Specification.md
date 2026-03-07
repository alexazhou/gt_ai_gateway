# v1.0 - MVP 技术实现方案

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

```typescript
// 通用类型定义
export interface BaseResponse<T = any> {
    [key: string]: T;
}

export interface PaginationParams {
    page?: number;
    pageSize?: number;
}

export interface TableQuery extends PaginationParams {
    keyword?: string;
}

export interface BaseEntity {
    id: number;
    created_at: Date;
    updated_at: Date;
}
```

### 3.2 用户类型（src/types/user.ts）

```typescript
export type UserType = 'normal' | 'admin';

export interface User extends BaseEntity {
    name: string;
    token: string;
    type: UserType;
}

export interface CreateUserRequest {
    name: string;
    token?: string;  // 可选，后端会自动生成
    type?: UserType;
}

export interface UserQuery extends TableQuery {
    type?: UserType;
}
```

### 3.3 供应商类型（src/types/vendor.ts）

```typescript
export type VendorType = 'aliyun' | 'deepseek' | 'other';
'openai' | 'anthropic' | 'google';

export interface VendorUrls {
    [key: string]: string;
}

export interface Vendor extends BaseEntity {
    type: VendorType;
    name: string;
    token: string;
    urls: VendorUrls;  // 后端返回时已是解析后的对象
}

export interface CreateVendorRequest {
    type: VendorType;
    name: string;
    token: string;
    urls?: VendorUrls;
}

export interface UpdateVendorRequest {
    type?: VendorType;
    name?: string;
    token?: string;
    urls?: VendorUrls;
}

export interface VendorQuery extends TableQuery {
    type?: VendorType;
    format?: ApiFormat;
}
```

### 3.4 模型类型（src/types/model.ts）

```typescript
export interface Model extends BaseEntity {
    name: string;
    vendor_id: number;
    enable: boolean;
}

export interface CreateModelRequest {
    name: string;
    vendor_id: number;
    enable?: boolean;
}

export interface UpdateModelRequest {
    name?: string;
    vendor_id?: number;
    enable?: boolean;
}

export interface ModelQuery extends TableQuery {
    vendor_id?: number;
}
```

---

## 四、API 模块设计

### 4.1 Axios 封装（src/utils/request.ts）

```typescript
import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { message } from 'ant-design-vue';

// 创建 axios 实例
const instance: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
});

// 请求拦截器 - 添加 Token
instance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        const token = localStorage.getItem('adminToken');
        if (token && config.headers) {
            config.headers['Authorization'] = `Bearer ${token}`;
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

// 响应拦截器 - 统一错误处理
instance.interceptors.response.use(
    (response) => {
        return response;
    },
    (error: AxiosError) => {
        const status = error.response?.status;
        const errorMessage = (error.response?.data as any)?.error || error.message;

        switch (status) {
            case 401:
                message.error('未授权，请重新登录');
                localStorage.removeItem('adminToken');
                window.location.href = '/login';
                break;
            case 403:
                message.error('权限不足');
                break;
            case 404:
                message.error('资源不存在');
                break;
            case 500:
                message.error('服务器错误');
                break;
            default:
                if (errorMessage) {
                    message.error(errorMessage);
                }
        }

        return Promise.reject(error);
    }
);

export default instance;
```

### 4.2 用户 API（src/api/user.ts）

```typescript
import request from '@/utils/request';
import type { User, CreateUserRequest, UserQuery } from '@/types/user';

// 获取用户列表
export function listUsers(query?: UserQuery): Promise<User[]> {
    return request.get('/user/list.json', { params: query });
}

// 获取用户详情
export function getUser(id: number): Promise<User> {
    return request.get(`/user/${id}`);
}

// 创建用户
export function createUser(data: CreateUserRequest): Promise<User> {
    return request.post('/user/create.json', data);
}

// 编辑用户（预留，后端暂未提供）
export function updateUser(id: number, data: Partial<CreateUserRequest>): Promise<User> {
    return request.put(`/user/${id}`, data);
}

// 删除用户（预留，v3.0 功能）
export function deleteUser(id: number): Promise<void> {
    return request.delete(`/user/${id}`);
}
```

### 4.3 供应商 API（src/api/vendor.ts）

```typescript
import request from '@/utils/request';
import type { Vendor, CreateVendorRequest, UpdateVendorRequest, VendorQuery } from '@/types/vendor';

// 获取供应商列表
export function listVendors(query?: VendorQuery): Promise<Vendor[]> {
    return request.get('/vendor/list.json', { params: query });
}

// 获取供应商详情
export function getVendor(id: number): Promise<Vendor> {
    return request.get(`/vendor/${id}`);
}

// 创建供应商
export function createVendor(data: CreateVendorRequest): Promise<Vendor> {
    return request.post('/vendor/create.json', data);
}

// 更新供应商
export function updateVendor(id: number, data: UpdateVendorRequest): Promise<Vendor> {
    return request.put(`/vendor/${id}`, data);
}

// 删除供应商（预留，v3.0 功能）
export function deleteVendor(id: number): Promise<void> {
    return request.delete(`/vendor/${id}`);
}
```

### 4.4 模型 API（src/api/model.ts）

```typescript
import request from '@/utils/request';
import type { Model, CreateModelRequest, UpdateModelRequest, ModelQuery } from '@/types/model';

// 获取模型列表
export function listModels(query?: ModelQuery): Promise<Model[]> {
    return request.get('/model/list.json', { params: query });
}

// 获取模型详情
export function getModel(id: number): Promise<Model> {
    return request.get(`/model/${id}`);
}

// 创建模型
export function createModel(data: CreateModelRequest): Promise<Model> {
    return request.post('/model/create.json', data);
}

// 更新模型
export function updateModel(id: number, data: UpdateModelRequest): Promise<Model> {
    return request.put(`/model/${id}`, data);
}

// 删除模型（预留，v3.0 功能）
export function deleteModel(id: number): Promise<void> {
    return request.delete(`/model/${id}`);
}
```

### 4.5 系统 API（src/api/system.ts）

```typescript
import request from '@/utils/request';

// 欢迎接口（用于验证 Token）
export function welcome(): Promise<any> {
    return request.get('/');
}

// 系统状态
export function status(): Promise<any> {
    return request.get('/status.json');
}
```

---

## 五、状态管理（Pinia）

### 5.1 认证状态（src/stores/auth.ts）

```typescript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { welcome } from '@/api/system';

export const useAuthStore = defineStore('auth', () => {
    const token = ref<string>(localStorage.getItem('adminToken') || '');
    const isLoading = ref(false);

    const isAuthenticated = computed(() => !!token.value);

    // 设置 Token
    function setToken(newToken: string) {
        token.value = newToken;
        localStorage.setItem('adminToken', newToken);
    }

    // 清除 Token
    function clearToken() {
        token.value = '';
        localStorage.removeItem('adminToken');
    }

    // 验证 Token
    async function validateToken(): Promise<boolean> {
        if (!token.value) return false;

        isLoading.value = true;
        try {
            await welcome();
            return true;
        } catch {
            clearToken();
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    // 登录
    async function login(newToken: string): Promise<boolean> {
        setToken(newToken);
        return await validateToken();
    }

    // 登出
    function logout() {
        clearToken();
    }

    return {
        token,
        isLoading,
        isAuthenticated,
        setToken,
        clearToken,
        validateToken,
        login,
        logout,
    };
});
```

### 5.2 应用状态（src/stores/app.ts）

```typescript
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAppStore = defineStore('app', () => {
    // 侧边栏折叠状态
    const sidebarCollapsed = ref(false);

    function toggleSidebar() {
        sidebarCollapsed.value = !sidebarCollapsed.value;
    }

    return {
        sidebarCollapsed,
        toggleSidebar,
    };
});
```

---

## 六、路由配置（src/router/index.ts）

```typescript
import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

// 路由配置
const routes: RouteRecordRaw[] = [
    {
        path: '/login',
        name: 'Login',
        component: () => import('@/views/Login.vue'),
        meta: { requiresAuth: false },
    },
    {
        path: '/',
        name: 'Layout',
        component: () => import('@/components/layout/AppLayout.vue'),
        meta: { requiresAuth: true },
        redirect: '/dashboard',
        children: [
            {
                path: 'dashboard',
                name: 'Dashboard',
                component: () => import('@/views/Dashboard.vue'),
                meta: { title: '仪表盘' },
            },
            {
                path: 'user',
                name: 'User',
                component: () => import('@/views/User/Index.vue'),
                meta: { title: '用户管理' },
                children: [
                    {
                        path: '',
                        name: 'UserList',
                        component: () => import('@/views/User/List.vue'),
                    },
                    {
                        path: ':id',
                        name: 'UserDetail',
                        component: () => import('@/views/User/Detail.vue'),
                    },
                ],
            },
            {
                path: 'vendor',
                name: 'Vendor',
                component: () => import('@/views/Vendor/Index.vue'),
                meta: { title: '供应商管理' },
                children: [
                    {
                        path: '',
                        name: 'VendorList',
                        component: () => import('@/views/Vendor/List.vue'),
                    },
                    {
                        path: ':id',
                        name: 'VendorDetail',
                        component: () => import('@/views/Vendor/Detail.vue'),
                    },
                ],
            },
            {
                path: 'model',
                name: 'Model',
            component: () => import('@/views/Model/Index.vue'),
                meta: { title: '模型管理' },
                children: [
                    {
                        path: '',
                        name: 'ModelList',
                        component: () => import('@/views/Model/List.vue'),
                    },
                    {
                        path: ':id',
                        name: 'ModelDetail',
                        component: () => import('@/views/Model/Detail.vue'),
                    },
                ],
            },
        ],
    },
];

// 创建路由
const router = createRouter({
    history: createWebHistory(),
    routes,
});

// 路由守卫
router.beforeEach(async (to, from, next) => {
    const authStore = useAuthStore();

    if (to.meta.requiresAuth !== false) {
        // 需要认证的路由
        if (!authStore.isAuthenticated) {
            // 未登录，跳转到登录页
            next({ name: 'Login', query: { redirect: to.fullPath } });
        } else {
            // 已登录，继续
            next();
        }
    } else {
        // 不需要认证的路由（如登录页）
        if (authStore.isAuthenticated && to.name === 'Login') {
            // 已登录访问登录页，跳转到首页
            next({ name: 'Dashboard' });
        } else {
            next();
        }
    }
});

export default router;
```

---

## 七、公共组件设计

### 7.1 TokenDisplay 组件（src/components/common/common/TokenDisplay.vue）

```vuevue
<template>
    <div class="token-display">
        <span v-if="showFull">{{ token }}</span>
        <span v-else>{{ maskedToken }}</span>
        <a-button type="link" size="small" @click="toggle">
            {{ showFull ? '隐藏' : '显示' }}
        </a-button>
        <a-button type="link" size="small" @click="copyToken">
            复制
        </a-button>
    </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { message } from 'ant-design-vue';

interface Props {
    token: string;
}

const props = defineProps<Props>();

const showFull = ref(false);

const maskedToken = computed(() => {
    if (!props.token) return '';
    if (props.token.length <= 8) return '****';
    return `${props.token.slice(0, 4)}...${props.token.slice(-4)}`;
});

function toggle() {
    showFull.value = !showFull.value;
}

function copyToken() {
    navigator.clipboard.writeText(props.token).then(() => {
        message.success('已复制到剪贴板');
    });
}
</script>

<style scoped>
.token-display {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
</style>
```

### 7.2 状态卡片组件（src/components/common/StatusCard.vue）

```vue
<template>
    <a-card :loading="loading" hoverable>
        <template #title>
            <span>{{ title }}</span>
        </template>
        <div class="status-content">
            <div class="status-value">{{ value }}</div>
            <div v-if="description" class="status-description">
                {{ description }}
            </div>
        </div>
    </a-card>
</template>

<script setup lang="ts">
interface Props {
    title: string;
    value: string | number;
    description?: string;
    loading?: boolean;
}

defineProps<Props>();
</script>

<style scoped>
.status-content {
    text-align: center;
}

.status-value {
    font-size: 32px;
    font-weight: bold;
    color: #1890ff;
}

.status-description {
    margin-top: 8px;
    color: #666;
}
</style>
```

---

## 八、组合式函数

### 8.1 useTable（src/composables/useTable.ts）

```typescript
import { ref, reactive } from 'vue';

export function useTable<T>(defaultPageSize: number = 10) {
    const loading = ref(false);
    const data = ref<T[]>([]);
    const total = ref(0);

    const pagination = reactive({
        current: 1,
        pageSize: defaultPageSize,
        total: 0,
        showSizeChanger: true,
        showQuickJumper: true,
        pageSizeOptions: ['10', '20', '50', '100'],
    });

    const searchForm = reactive<Record<string, any>>({});

    function setPage(page: number, pageSize?: number) {
        pagination.current = page;
        if (pageSize) {
            pagination.pageSize = pageSize;
        }
    }

    function resetSearch() {
        Object.keys(searchForm).forEach(key => {
            searchForm[key] = undefined;
        });
        pagination.current = 1;
    }

    return {
        loading,
        data,
        total,
        pagination,
        searchForm,
        setPage,
        resetSearch,
    };
}
```

---

## 九、环境变量配置

### .env.example
```
# API 基础 URL
VITE_API_BASE_URL=http://localhost:8787

# 应用标题
VITE_APP_TITLE=Serverless AI Gateway
```

---

## 十、初始化项目命令

```bash
# 创建 Vite + Vue 3 + TypeScript 项目
npm create vite@latest frontend -- --template vue-ts

cd frontend

# 安装依赖
npm install ant-design-vue vue-router pinia axios dayjs lodash-es @vueuse/core

# 安装类型定义
npm install -D @types/lodash-es
```

---

*文档版本：v1.0*
*创建日期：2026-03-07*