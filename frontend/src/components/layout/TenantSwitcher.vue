<template>
    <a-dropdown v-if="visible">
        <a-button type="text" class="tenant-btn" :class="`tenant-btn--${variant}`">
            <ApartmentOutlined />
            <span class="tenant-name">{{ currentTenantName }}</span>
        </a-button>
        <template #overlay>
            <a-menu :selected-keys="[currentTenantKey]" @click="handleTenantSelect">
                <a-menu-item v-for="t in tenantStore.tenants" :key="String(t.id)">
                    <span>{{ t.name }}</span>
                    <a-tag v-if="t.name === 'main'" color="blue" style="margin-left: 8px;">主</a-tag>
                </a-menu-item>
            </a-menu>
        </template>
    </a-dropdown>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { message } from 'ant-design-vue/es';
import { ApartmentOutlined } from '@ant-design/icons-vue';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

withDefaults(defineProps<{ variant?: 'header' | 'sidebar' }>(), {
    variant: 'header',
});

const authStore = useAuthStore();
const tenantStore = useTenantStore();

const visible = computed(() => authStore.isSystemAdmin && tenantStore.multiTenantEnabled);

const currentTenantName = computed(() => {
    const view = tenantStore.currentTenantIdNum;
    const tenant = tenantStore.tenants.find(t => t.id === view);
    return tenant ? tenant.name : '主视角';
});
const currentTenantKey = computed(() => tenantStore.currentTenantId || '');

// isSystemAdmin / multiTenantEnabled 均为异步来自 /status.json，onMounted 单次判断会在两者就绪前
// 错过加载导致下拉为空；改为 watch 在条件满足时触发（立即执行 + 异步就绪后自动补触发）
watch(
    [() => authStore.isSystemAdmin, () => tenantStore.multiTenantEnabled],
    ([isSystemAdmin, multiTenantEnabled]) => {
        if (isSystemAdmin && multiTenantEnabled) {
            tenantStore.loadTenants();
        }
    },
    { immediate: true },
);

function handleTenantSelect({ key }: { key: string }) {
    if (key === tenantStore.currentTenantId) return;
    tenantStore.setTenant(key);
    message.success('已切换租户视角');
}
</script>

<style scoped>
.tenant-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-inline: 10px;
    height: 30px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--bg-hover, rgba(128, 128, 128, 0.12));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
}

.tenant-btn--header {
    margin-left: 12px;
}

.tenant-btn--sidebar {
    width: 100%;
    justify-content: flex-start;
}

.tenant-btn:hover {
    background: var(--sidebar-hover, rgba(128, 128, 128, 0.2));
}

.tenant-btn :deep(.anticon) {
    font-size: 14px;
    flex: none;
}

.tenant-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
