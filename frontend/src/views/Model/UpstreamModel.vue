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
    border-radius: 4px;
    font-size: 13px;
    vertical-align: middle;
}

.vendor-name {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    padding: 5px 7px 4px;
    line-height: 1;
    background: var(--accent-primary-soft);
    border: 1px solid var(--accent-primary-border);
    border-right: 0;
    border-radius: 4px 0 0 4px;
    color: var(--accent-primary);
    font-family: monospace;
    font-weight: 400;
}

.model-name {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    padding: 5px 7px 4px;
    line-height: 1;
    background: var(--bg-info-item);
    border: 1px solid #d9d9d9;
    border-left: 0;
    border-radius: 0 4px 4px 0;
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
}

.upstream-model.disabled {
    opacity: 0.5;
}
</style>
