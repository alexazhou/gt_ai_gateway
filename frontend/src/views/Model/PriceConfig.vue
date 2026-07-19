<template>
    <a-collapse
        v-if="mode === 'edit'"
        v-model:active-key="activeKey"
        :bordered="false"
        class="price-settings"
    >
        <a-collapse-panel key="billing">
            <template #header>
                <span v-if="isExpanded">价格设置</span>
                <div v-else class="price-display">
                    <span class="price-item" title="输入价格">
                        <ArrowUpOutlined class="price-icon input" />
                        ¥{{ formatPrice(prices.input) }}
                    </span>
                    <span class="price-divider">/</span>
                    <span class="price-item" title="输出价格">
                        <ArrowDownOutlined class="price-icon output" />
                        ¥{{ formatPrice(prices.output) }}
                    </span>
                    <span class="price-divider">/</span>
                    <span class="price-item" title="缓存读取价格">
                        <ArrowUpOutlined class="price-icon cache-read" />
                        ¥{{ formatPrice(prices.cache_read) }}
                    </span>
                </div>
            </template>
            <div class="settings-row">
                <label class="settings-label">
                    输入价格
                    <a-tooltip title="输入 token 的计费价格（元/千 tokens）">
                        <InfoCircleOutlined class="field-help-icon" />
                    </a-tooltip>
                </label>
                <a-input-number
                    :value="prices.input"
                    placeholder="请输入输入价格"
                    :min="0"
                    :precision="6"
                    style="width: 100%"
                    @update:value="updatePrice('input', $event)"
                />
            </div>
            <div class="settings-row">
                <label class="settings-label">
                    输出价格
                    <a-tooltip title="输出 token 的计费价格（元/千 tokens）">
                        <InfoCircleOutlined class="field-help-icon" />
                    </a-tooltip>
                </label>
                <a-input-number
                    :value="prices.output"
                    placeholder="请输入输出价格"
                    :min="0"
                    :precision="6"
                    style="width: 100%"
                    @update:value="updatePrice('output', $event)"
                />
            </div>
            <div class="settings-row">
                <label class="settings-label">
                    缓存读取价格
                    <a-tooltip title="缓存命中时读取 token 的计费价格（元/千 tokens）">
                        <InfoCircleOutlined class="field-help-icon" />
                    </a-tooltip>
                </label>
                <a-input-number
                    :value="prices.cache_read"
                    placeholder="请输入缓存读取价格"
                    :min="0"
                    :precision="6"
                    style="width: 100%"
                    @update:value="updatePrice('cache_read', $event)"
                />
            </div>
        </a-collapse-panel>
    </a-collapse>

    <div v-else class="price-display">
        <span class="price-item" title="输入价格">
            <ArrowUpOutlined class="price-icon input" />
            ¥{{ formatPrice(prices.input) }}
        </span>
        <span class="price-divider">/</span>
        <span class="price-item" title="输出价格">
            <ArrowDownOutlined class="price-icon output" />
            ¥{{ formatPrice(prices.output) }}
        </span>
        <span class="price-divider">/</span>
        <span class="price-item" title="缓存读取价格">
            <ArrowUpOutlined class="price-icon cache-read" />
            ¥{{ formatPrice(prices.cache_read) }}
        </span>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
    ArrowDownOutlined,
    ArrowUpOutlined,
    InfoCircleOutlined,
} from '@ant-design/icons-vue';
import type { ModelPrices } from '@/types/model';

const props = defineProps<{
    mode: 'edit' | 'view';
    prices: ModelPrices;
}>();

const emit = defineEmits<{
    'update:prices': [prices: ModelPrices];
}>();

const activeKey = ref<string[]>([]);

const isExpanded = computed(() => activeKey.value.includes('billing'));

function updatePrice(key: keyof ModelPrices, value: number | null) {
    emit('update:prices', {
        ...props.prices,
        [key]: value ?? undefined,
    });
}


function formatPrice(value?: number): string {
    return (value ?? 0).toFixed(6);
}
</script>

<style scoped>
.price-settings {
    margin-top: 0;
    background: transparent;
    border: none;
}

.price-settings :deep(.ant-collapse-item) {
    border: 1px solid var(--border-color, #d9d9d9) !important;
    border-radius: 6px !important;
}

.price-settings :deep(.ant-collapse-header) {
    padding: 8px 16px;
    font-size: 13px;
}

.price-settings :deep(.ant-collapse-content-box) {
    padding: 0 16px 12px;
}

.settings-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
}

.settings-row:last-child {
    margin-bottom: 0;
}

.settings-label {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    width: 100px;
    font-size: 14px;
    color: rgba(0, 0, 0, 0.88);
}

.field-help-icon {
    margin-left: 4px;
    color: var(--text-secondary);
    font-size: 13px;
}

.price-display {
    display: flex;
    align-items: center;
}

.price-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.price-icon {
    font-size: 14px;
}

.price-icon.input {
    color: var(--accent-primary);
}

.price-icon.output {
    color: #52c41a;
}

.price-icon.cache-read {
    color: #722ed1;
}

.price-divider {
    margin: 0 8px;
    color: var(--token-divider);
}
</style>
