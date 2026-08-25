<template>
    <div class="app-layout">
        <AppHeader />
        <div class="layout-body">
            <AppSidebar />
            <div class="main-content">
                <router-view :key="viewKey" />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppHeader from './AppHeader.vue';
import AppSidebar from './AppSidebar.vue';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

const authStore = useAuthStore();
const tenantStore = useTenantStore();
const route = useRoute();
const router = useRouter();

// 视图 key = 路由路径 + 当前租户视角：切换租户（顶栏下拉，不触发导航）时 key 变化，
// 强制重建路由视图让 onMounted 重新拉取数据，避免残留上一个租户的页面信息
const viewKey = computed(() => `${route.fullPath}|${tenantStore.currentTenantId}`);

// 仅 main 视角可用的路由（requiresMainView，如租户管理）：切换租户视角后若停在
// 该页面，自动跳回仪表盘（顶栏切换不触发路由守卫，需在此兜底）
watch(
    () => tenantStore.currentTenantId,
    () => {
        if (route.meta.requiresMainView && !tenantStore.isMainView) {
            router.push({ name: 'Dashboard' });
        }
    },
);

onMounted(() => {
    if (authStore.isAuthenticated && !authStore.userType) {
        authStore.validateToken();
    }
});
</script>

<style scoped>
.app-layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-layout);
}

.layout-body {
    display: flex;
    flex: 1;
    overflow: hidden;
}

.main-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    background: var(--bg-page);
}
</style>
