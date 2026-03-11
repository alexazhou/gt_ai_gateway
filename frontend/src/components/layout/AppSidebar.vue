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
                <a-menu-item key="/api-test">
                    <ExperimentOutlined />
                    <span>API 测试</span>
                </a-menu-item>
            </a-menu>
        </div>
        <div class="sidebar-footer">
            <a-button
                type="text"
                @click="toggleSidebar"
                class="collapse-btn"
            >
                <MenuFoldOutlined v-if="!collapsed" />
                <MenuUnfoldOutlined v-else />
            </a-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { DashboardOutlined, UserOutlined, ApiOutlined, SettingOutlined, FileTextOutlined, ExperimentOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons-vue';
import { useAppStore } from '@/stores/app';

const router = useRouter();
const route = useRoute();
const appStore = useAppStore();

const collapsed = computed(() => appStore.sidebarCollapsed);

const selectedKeys = computed(() => {
    const path = route.path;
    if (path.startsWith('/user')) return ['/user'];
    if (path.startsWith('/vendor')) return ['/vendor'];
    if (path.startsWith('/model')) return ['/model'];
    if (path.startsWith('/record')) return ['/record'];
    if (path.startsWith('/api-test')) return ['/api-test'];
    return [path];
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
    width: 200px;
    height: 100%;
    background: #fff;
    border-right: 1px solid #e8e8e8;
    transition: all 0.3s;
    display: flex;
    flex-direction: column;
    z-index: 10;
}

.app-sidebar.collapsed {
    width: 80px;
}

.sidebar-content {
    padding-top: 16px;
    flex: 1;
    overflow-y: auto;
}

.sidebar-footer {
    padding: 16px;
}

.collapse-btn {
    font-size: 18px;
}
</style>
