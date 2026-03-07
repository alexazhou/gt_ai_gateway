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
            </a-menu>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { DashboardOutlined, UserOutlined, ApiOutlined, SettingOutlined } from '@ant-design/icons-vue';
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
    return [path];
});

function handleSelect({ key }: { key: string }) {
    router.push(key);
}
</script>

<style scoped>
.app-sidebar {
    width: 200px;
    height: 100%;
    background: #fff;
    border-right: 1px solid #e8e8e8;
    transition: all 0.3s;
}

.app-sidebar.collapsed {
    width: 64px;
}

.sidebar-content {
    padding-top: 16px;
}
</style>
