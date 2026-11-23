<template>
    <div class="app-header">
        <div class="header-left">
            <AppBrand />
            <TenantSwitcher variant="header" />
        </div>
        <div class="header-right">
            <ThemeToggleButton />
            <a-dropdown>
                <a-button type="text" class="user-btn">
                    <UserOutlined />
                    <span class="username" :title="displayName">{{ displayName }}</span>
                </a-button>
                <template #overlay>
                    <a-menu>
                        <a-menu-item @click="handleLogout">
                            <LogoutOutlined />
                            <span>退出登录</span>
                        </a-menu-item>
                    </a-menu>
                </template>
            </a-dropdown>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { message } from 'ant-design-vue/es';
import { UserOutlined, LogoutOutlined } from '@ant-design/icons-vue';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import AppBrand from './AppBrand.vue';
import ThemeToggleButton from './ThemeToggleButton.vue';
import TenantSwitcher from './TenantSwitcher.vue';

// 顶栏只在 Web 端渲染；桌面端（macOS / Windows）用侧边栏顶部承载品牌与操作入口
const router = useRouter();
const authStore = useAuthStore();
const tenantStore = useTenantStore();

// 顶栏展示登录用户名；旧后端不返回 user_name 时退回身份标识，避免显示空白
const displayName = computed(() => authStore.userName || authStore.userType || 'Admin');


function handleLogout() {
    authStore.logout();
    tenantStore.reset();
    message.success('已退出登录');
    router.push('/login');
}
</script>

<style scoped>
.app-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 24px;
    height: 48px;
    background: var(--bg-header);
    /* 深色模式下阴影不可见，用主题边框保证顶栏分割线始终存在 */
    border-bottom: 1px solid var(--border-color);
    box-shadow: var(--header-shadow);
    position: relative;
    z-index: 20;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 12px;
}

.header-right {
    display: flex;
    align-items: center;
    gap: 4px;
}

.user-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-inline: 4px;
    font-size: 17px;
}

.user-btn :deep(.anticon) {
    font-size: 18px;
}

.username {
    font-size: 14px;
    color: var(--text-primary);
    /* 用户名由用户自填且长度不限，超长时省略而不是撑破顶栏 */
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
