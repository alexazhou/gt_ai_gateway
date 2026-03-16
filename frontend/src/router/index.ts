import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

// 静态导入所有页面组件
import Login from '@/views/Login.vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import Dashboard from '@/views/Dashboard.vue';
import UserIndex from '@/views/User/Index.vue';
import UserList from '@/views/User/List.vue';
import UserDetail from '@/views/User/Detail.vue';
import VendorIndex from '@/views/Vendor/Index.vue';
import VendorList from '@/views/Vendor/List.vue';
import VendorDetail from '@/views/Vendor/Detail.vue';
import ModelIndex from '@/views/Model/Index.vue';
import ModelList from '@/views/Model/List.vue';
import ModelDetail from '@/views/Model/Detail.vue';
import RecordIndex from '@/views/Record/Index.vue';
import RecordList from '@/views/Record/List.vue';
import RecordDetail from '@/views/Record/Detail.vue';
import ApiTestIndex from '@/views/ApiTest/Index.vue';
import IntegrationIndex from '@/views/Integration/Index.vue';

const routes: RouteRecordRaw[] = [
    {
        path: '/login',
        name: 'Login',
        component: Login,
        meta: { requiresAuth: false },
    },
    {
        path: '/',
        name: 'Layout',
        component: AppLayout,
        meta: { requiresAuth: true },
        redirect: '/dashboard',
        children: [
            {
                path: 'dashboard',
                name: 'Dashboard',
                component: Dashboard,
                meta: { title: '仪表盘' },
            },
            {
                path: 'user',
                name: 'User',
                component: UserIndex,
                meta: { title: '用户管理' },
                children: [
                    {
                        path: '',
                        name: 'UserList',
                        component: UserList,
                    },
                    {
                        path: ':id',
                        name: 'UserDetail',
                        component: UserDetail,
                    },
                ],
            },
            {
                path: 'vendor',
                name: 'Vendor',
                component: VendorIndex,
                meta: { title: '供应商管理' },
                children: [
                    {
                        path: '',
                        name: 'VendorList',
                        component: VendorList,
                    },
                    {
                        path: ':id',
                        name: 'VendorDetail',
                        component: VendorDetail,
                    },
                ],
            },
            {
                path: 'model',
                name: 'Model',
                component: ModelIndex,
                meta: { title: '模型管理' },
                children: [
                    {
                        path: '',
                        name: 'ModelList',
                        component: ModelList,
                    },
                    {
                        path: ':id',
                        name: 'ModelDetail',
                        component: ModelDetail,
                    },
                ],
            },
            {
                path: 'record',
                name: 'Record',
                component: RecordIndex,
                meta: { title: '请求记录' },
                children: [
                    {
                        path: '',
                        name: 'RecordList',
                        component: RecordList,
                    },
                    {
                        path: ':id',
                        name: 'RecordDetail',
                        component: RecordDetail,
                    },
                ],
            },
            {
                path: 'api-test',
                name: 'ApiTest',
                component: ApiTestIndex,
                meta: { title: 'API 测试' },
            },
            {
                path: 'integration',
                name: 'Integration',
                component: IntegrationIndex,
                meta: { title: '接入配置' },
            },
        ],
    },
];

const router = createRouter({
    history: createWebHashHistory(),
    routes,
});

router.beforeEach(async (to, _from, next) => {
    const authStore = useAuthStore();

    if (to.meta.requiresAuth !== false) {
        if (!authStore.isAuthenticated) {
            next({ name: 'Login', query: { redirect: to.fullPath } });
        } else {
            next();
        }
    } else {
        if (authStore.isAuthenticated && to.name === 'Login') {
            next({ name: 'Dashboard' });
        } else {
            next();
        }
    }
});

export default router;
