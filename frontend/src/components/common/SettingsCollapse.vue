<template>
    <a-collapse :active-key="activeKey" :bordered="false" class="settings-collapse" @change="$emit('update:activeKey', $event)">
        <a-collapse-panel :key="panelKey" :header="header">
            <slot />
        </a-collapse-panel>
    </a-collapse>
</template>

<script setup lang="ts">
defineProps<{
    activeKey: string[];
    panelKey: string;
    header: string;
}>();

defineEmits<{
    'update:activeKey': [value: string[]];
}>();
</script>

<style scoped>
.settings-collapse {
    background: transparent;
    border: none;
    margin-top: 8px;
}

:deep(.ant-collapse-item) {
    border: 1px solid var(--border-color, #d9d9d9) !important;
    border-radius: 6px !important;
}

:deep(.ant-collapse-header) {
    padding: 8px 16px;
    font-size: 13px;
}

:deep(.ant-collapse-content-box) {
    padding: 0 16px 12px;
}

:deep(.settings-row) {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
}

:deep(.settings-row:last-child) {
    margin-bottom: 0;
}

:deep(.settings-label) {
    flex-shrink: 0;
    width: 100px;
    font-size: 14px;
    color: var(--text-primary);
    display: flex;
    align-items: center;
}
</style>
