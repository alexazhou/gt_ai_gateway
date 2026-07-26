<template>
    <span class="upstream-model" :class="{ disabled }">
        <span class="vendor-name">{{ vendorName }}</span>
        <span class="model-name">
            {{ modelName }}
            <a-tooltip v-if="autoMapped" title="自动使用客户端传入的模型名字来请求上游">
                <InfoCircleOutlined class="auto-mapping-icon" />
            </a-tooltip>
        </span>
    </span>
</template>

<script setup lang="ts">
import { InfoCircleOutlined } from '@ant-design/icons-vue';

defineProps<{
    vendorName: string;
    modelName: string;
    autoMapped?: boolean;
    disabled?: boolean;
}>();
</script>

<style scoped>
.upstream-model {
    display: inline-flex;
    max-width: 100%;
    overflow: hidden;
    border: 1px solid var(--accent-primary-border);
    border-radius: 4px;
    font-size: 13px;
    line-height: 22px;
    vertical-align: middle;
}

.vendor-name {
    flex: 0 0 auto;
    padding: 0 7px;
    background: var(--accent-primary-soft);
    color: var(--accent-primary);
    font-weight: 400;
}

.model-name {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    padding: 0 7px;
    background: var(--bg-info-item);
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
    font-family: monospace;
    font-size: inherit;
}

.auto-mapping-icon {
    margin-left: 4px;
    color: var(--text-secondary);
    cursor: help;
    font-size: 11px;
    vertical-align: -1px;
}

.upstream-model.disabled {
    opacity: 0.5;
}
</style>
