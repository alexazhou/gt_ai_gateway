import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

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

const router = createRouter({
    history: createWebHistory(),
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
