<template>
    <div class="app-sidebar" :class="{ collapsed: collapsed }">
        <div class="sidebar-content">
            <a-menu
                :selected-keys="selectedKeys"
                mode="inline"
                :inline-collapsed="collapsed"
                @select="handleSelect"
            >
                <a-menu-item key="/dashboard">
                    <DashboardOutlined />
                    <span>仪表盘</span>
                </a-menu-item>
                <a-menu-item key="/user">
                    <UserOutlined />
                    <span>用户管理</span>
                </a-menu-item>
                <a-menu-item key="/vendor">
                    <ApiOutlined />
                    <span>供应商管理</span>
                </a-menu-item>
                <a-menu-item key="/model">
                    <SettingOutlined />
                    <span>模型管理</span>
                </a-menu-item>
                <a-menu-item key="/record">
                    <FileTextOutlined />
                    <span>请求记录</span>
                </a-menu-item>
                <a-menu-item key="/balance">
                    <DollarOutlined />
                    <span>余额管理</span>
                </a-menu-item>
                <a-menu-item key="/api-test">
                    <ExperimentOutlined />
                    <span>API 测试</span>
                </a-menu-item>
                <a-menu-item key="/integration">
                    <LinkOutlined />
                    <span>接入配置</span>
                </a-menu-item>
            </a-menu>
        </div>
        <div class="sidebar-footer">
            <div class="footer-left">
                <a-button
                    type="text"
                    @click="toggleSidebar"
                    class="collapse-btn"
                >
                    <MenuFoldOutlined v-if="!collapsed" />
                    <MenuUnfoldOutlined v-else />
                </a-button>
            </div>
            <div v-if="!collapsed" class="footer-right">
                <span class="version-text">v{{ version }}</span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { DashboardOutlined, UserOutlined, ApiOutlined, SettingOutlined, FileTextOutlined, ExperimentOutlined, MenuFoldOutlined, MenuUnfoldOutlined, LinkOutlined, DollarOutlined } from '@ant-design/icons-vue';
import { useAppStore } from '@/stores/app';

const router = useRouter();
const route = useRoute();
const appStore = useAppStore();

const collapsed = computed(() => appStore.sidebarCollapsed);
const version = computed(() => appStore.version);

const selectedKeys = computed(() => {
    const path = route.path;
    if (path.startsWith('/user')) return ['/user'];
    if (path.startsWith('/vendor')) return ['/vendor'];
    if (path.startsWith('/model')) return ['/model'];
    if (path.startsWith('/record')) return ['/record'];
    if (path.startsWith('/balance')) return ['/balance'];
    if (path.startsWith('/api-test')) return ['/api-test'];
    if (path.startsWith('/integration')) return ['/integration'];
    return [path];
});

onMounted(() => {
    if (!appStore.version) {
        appStore.fetchVersion();
    }
});

function handleSelect({ key }: { key: string }) {
    router.push(key);
}

function toggleSidebar() {
    appStore.toggleSidebar();
}
</script>

<style scoped>
.app-sidebar {
    width: 232px;
    height: 100%;
    background: var(--bg-sidebar-gradient);
    border-right: 1px solid var(--border-color);
    transition: all 0.3s;
    display: flex;
    flex-direction: column;
    z-index: 10;
}

.app-sidebar.collapsed {
    width: 88px;
}

.sidebar-content {
    padding: 18px 10px 12px;
    flex: 1;
    overflow-y: auto;
}

.sidebar-footer {
    padding: 12px 14px 16px;
    display: flex;
    align-items: center;
    overflow: hidden;
}

.footer-left {
    flex-shrink: 0;
}

.footer-right {
    flex: 1;
    margin-left: 8px;
    display: flex;
    align-items: center;
    white-space: nowrap;
    line-height: 1;
}

.collapse-btn {
    width: 40px;
    height: 40px;
    padding: 0;
    border-radius: 12px;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--collapse-btn-text);
    background: var(--collapse-btn-bg);
}

.version-text {
    font-size: 14px;
    color: var(--text-version);
    font-weight: 600;
}

.app-sidebar :deep(.ant-menu) {
    border-inline-end: none;
    background: transparent;
    width: 100%;
}

.app-sidebar :deep(.ant-menu-item) {
    height: 48px;
    line-height: 48px;
    margin: 6px 0;
    padding-inline: 14px !important;
    width: 100%;
    box-sizing: border-box;
    border-radius: 14px;
    color: var(--text-sidebar);
    font-size: 16px;
    font-weight: 500;
    transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease;
}

.app-sidebar :deep(.ant-menu-title-content) {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-width: 0;
}

.app-sidebar :deep(.ant-menu-item .anticon) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 20px;
    min-width: 20px;
    font-size: 18px;
    line-height: 1;
    color: var(--text-sidebar-icon);
    vertical-align: middle;
}

.app-sidebar :deep(.ant-menu-item .anticon svg) {
    display: block;
}

.app-sidebar :deep(.ant-menu-item:hover) {
    background: var(--sidebar-hover);
    color: var(--sidebar-hover-text);
}

.app-sidebar :deep(.ant-menu-item:hover .anticon) {
    color: var(--sidebar-hover-text);
}

.app-sidebar :deep(.ant-menu-item-selected) {
    background: var(--sidebar-selected);
    color: var(--sidebar-selected-text);
    box-shadow: inset 0 0 0 1px rgba(37, 143, 255, 0.16);
}

.app-sidebar :deep(.ant-menu-item-selected .anticon) {
    color: var(--sidebar-selected-text);
}

.app-sidebar.collapsed :deep(.ant-menu-item) {
    padding-inline: 0 !important;
    display: flex;
    align-items: center;
    justify-content: center;
}

.app-sidebar.collapsed :deep(.ant-menu-inline-collapsed .ant-menu-item) {
    inset-inline-start: 0;
    padding-inline: 0 !important;
    width: 100%;
}

.app-sidebar.collapsed :deep(.ant-menu-title-content) {
    justify-content: center;
    gap: 0;
}

.app-sidebar.collapsed :deep(.ant-menu-title-content > span:not(.anticon)) {
    display: none;
}
</style>
