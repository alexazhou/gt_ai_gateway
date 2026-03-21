<template>
    <div class="json-viewer">
        <div class="json-header">
            <a-space>
                <a-button size="small" @click="toggleExpand">
                    {{ isExpanded ? '收起' : '展开' }}
                </a-button>
                <a-button size="small" @click="handleCopy">
                    复制
                </a-button>
            </a-space>
        </div>
        <div class="json-content" :class="{ expanded: isExpanded }">
            <pre v-if="formattedData">{{ formattedData }}</pre>
            <div v-else class="empty">无数据</div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { message } from 'ant-design-vue/es';

interface Props {
    data: unknown;
}

const props = defineProps<Props>();

const isExpanded = ref(true);

const formattedData = computed(() => {
    if (!props.data) return null;
    try {
        if (typeof props.data === 'string') {
            // 尝试解析 JSON 字符串
            const parsed = JSON.parse(props.data);
            return JSON.stringify(parsed, null, 2);
        }
        return JSON.stringify(props.data, null, 2);
    } catch {
        // 如果不是有效的 JSON，直接返回字符串
        return String(props.data);
    }
});

function toggleExpand() {
    isExpanded.value = !isExpanded.value;
}

async function handleCopy() {
    if (!formattedData.value) return;
    try {
        await navigator.clipboard.writeText(formattedData.value);
        message.success('已复制到剪贴板');
    } catch {
        message.error('复制失败');
    }
}
</script>

<style scoped>
.json-viewer {
    background: var(--bg-code);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
}

.json-header {
    padding: 8px 12px;
    background: var(--bg-code-header);
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: flex-end;
}

.json-content {
    max-height: 200px;
    overflow: auto;
    transition: max-height 0.3s;
}

.json-content.expanded {
    max-height: 600px;
}

.json-content pre {
    margin: 0;
    padding: 12px;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-wrap: break-word;
}

.empty {
    padding: 24px;
    text-align: center;
    color: var(--text-secondary);
}
</style>
