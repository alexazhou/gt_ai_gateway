<template>
    <div class="app-layout">
        <!-- 桌面端不渲染顶栏：品牌与操作入口移入侧边栏，侧边栏分割线直达窗口顶部；
             Web 保持原有顶栏布局 -->
        <AppHeader v-if="!isDesktopApp" />
        <div class="layout-body">
            <AppSidebar />
            <div class="main-column">
                <!-- 桌面端主内容顶部留出拖动区：macOS 为原生红绿灯留位，
                     Windows 同时作为自绘窗口的控制条 -->
                <div
                    v-if="isDesktopApp"
                    class="window-drag-strip"
                    :class="{ 'window-drag-strip--windows': isWindowsApp }"
                    data-tauri-drag-region="deep"
                ></div>
                <!-- 侧边栏收起后，主题切换跨过分割线停在主内容左侧 -->
                <ThemeToggleButton
                    v-if="isDesktopApp && appStore.sidebarCollapsed"
                    size="small"
                    class="collapsed-theme-btn"
                />
                <div
                    class="main-content"
                    :class="{ 'main-content--mac': isMacOverlay, 'main-content--windows': isWindowsApp }"
                >
                    <router-view :key="viewKey" />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppHeader from './AppHeader.vue';
import AppSidebar from './AppSidebar.vue';
import ThemeToggleButton from './ThemeToggleButton.vue';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { isDesktopTauri, isMacTauri, isWindowsTauri } from '@/utils/platform';

// macOS 红绿灯浮在页面内容之上；Windows 使用无边框窗口与自绘标题栏
const isMacOverlay = isMacTauri();
const isWindowsApp = isWindowsTauri();
// 两端桌面端均无应用顶栏：品牌与操作入口移入侧边栏，顶部保留拖动区
const isDesktopApp = isDesktopTauri();

const appStore = useAppStore();
const authStore = useAuthStore();
const tenantStore = useTenantStore();
const route = useRoute();
const router = useRouter();

// 视图 key = 路由路径 + 当前租户视角：切换租户（顶栏/侧边栏下拉，不触发导航）时 key 变化，
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

.main-column {
    flex: 1;
    min-width: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.collapsed-theme-btn {
    position: absolute;
    top: 2px;
    left: 10px;
    z-index: 5;
}

.window-drag-strip {
    flex: 0 0 24px;
    background: var(--bg-page);
}

/* Windows 自绘标题栏高度与侧边栏品牌行一致（见 AppSidebar .desktop-brand-row--windows），
   两列内容从同一水平线开始 */
.window-drag-strip--windows {
    flex-basis: 44px;
}

.main-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
    background: var(--bg-page);
}

/* 桌面端无顶栏：收紧顶部留白。
   macOS 拖动区 24px + 13px；Windows 拖动区 44px（与侧边栏品牌行同高）+ 5px */
.main-content--mac {
    padding-top: 13px;
}

.main-content--windows {
    padding-top: 5px;
}
</style>
