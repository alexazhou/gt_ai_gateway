<template>
    <a-table
        :columns="displayColumns"
        :data-source="records"
        :loading="loading"
        :pagination="pagination"
        :size="size"
        @change="handleTableChange"
        :row-key="(record: Record) => record.id"
    >
        <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'status'">
                <a-tag :color="getStatusColor(record.status)">
                    {{ getStatusText(record.status, record.failed_code) }}
                </a-tag>
            </template>
            <template v-else-if="column.key === 'token_stats'">
                <div class="metric-cell">
                    <div v-if="record.prompt_tokens !== null || record.output_tokens !== null">
                        <span class="token-item" title="输入 Token">
                            <ArrowUpOutlined class="token-icon input" />
                            {{ record.prompt_tokens ?? 0 }}
                        </span>
                        <span class="token-divider">/</span>
                        <span class="token-item" title="输出 Token">
                            <ArrowDownOutlined class="token-icon output" />
                            {{ record.output_tokens ?? 0 }}
                        </span>
                    </div>
                    <div v-else>-</div>
                </div>
            </template>
            <template v-else-if="column.key === 'timing'">
                <div class="metric-cell">
                    <div>{{ formatDuration(record.start_at, record.end_at) }}</div>
                    <div v-if="record.first_token_latency !== null" class="metric-sub">
                        首 Token {{ record.first_token_latency }}ms
                    </div>
                </div>
            </template>
            <template v-if="column.key === 'created_at'">
                {{ formatDate(record.created_at) }}
            </template>
            <template v-if="column.key === 'action'">
                <a-button type="link" size="small" @click="handleView(record)">
                    查看
                </a-button>
            </template>
        </template>
    </a-table>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import { useRouter } from 'vue-router';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons-vue';
import { formatDate } from '@/utils/format';
import type { Record } from '@/types/record';
import dayjs from 'dayjs';

interface Props {
    records: Record[];
    loading?: boolean;
    pagination?: false | TablePaginationConfig;
    size?: 'small' | 'middle' | 'default';
    columns?: TableColumnsType<Record>;
}

const props = withDefaults(defineProps<Props>(), {
    loading: false,
    pagination: false,
    size: 'default',
});

const emit = defineEmits<{
    change: [pagination: TablePaginationConfig];
}>();

const router = useRouter();

const defaultColumns: TableColumnsType<Record> = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '用户', key: 'user_name', dataIndex: 'user_name' },
    { title: '供应商', key: 'vendor_name', dataIndex: 'vendor_name' },
    { title: '模型', key: 'model_name', dataIndex: 'model_name' },
    { title: 'Token', key: 'token_stats', width: 140 },
    { title: '时间', key: 'timing', width: 140 },
    { title: '状态', key: 'status', dataIndex: 'status', width: 140 },
    { title: '创建时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 80, fixed: 'right' as const },
];

const displayColumns = computed(() => {
    return props.columns || defaultColumns;
});

function handleTableChange(pag: TablePaginationConfig) {
    emit('change', pag);
}

function handleView(record: Record) {
    router.push({
        name: 'RecordDetail',
        params: { id: String(record.id) },
    });
}

function normalizeTimestamp(value: string | number | null): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (typeof value === 'number') {
        return value;
    }

    if (/^\d+$/.test(value)) {
        return Number(value);
    }

    const parsed = dayjs(value).valueOf();
    return Number.isNaN(parsed) ? null : parsed;
}

function formatDuration(startAt: string | number | null, endAt: string | number | null): string {
    const start = normalizeTimestamp(startAt);
    const end = normalizeTimestamp(endAt);

    if (start === null || end === null) {
        return '-';
    }

    const duration = end - start;
    return Number.isNaN(duration) ? '-' : `${duration.toLocaleString()}ms`;
}

function getStatusColor(status: string | null): string {
    switch (status) {
        case 'success':
            return 'success';
        case 'failed':
            return 'error';
        case 'processing':
            return 'processing';
        case 'init':
        default:
            return 'default';
    }
}

const FAILED_CODE_LABELS: { [key: string]: string } = {
    client_disconnected: '客户端断开',
    upstream_disconnected: '上游断开',
    stream_incomplete: '流不完整',
};

function getStatusText(status: string | null, failedCode?: string | null): string {
    switch (status) {
        case 'success':
            return '成功';
        case 'failed':
            return failedCode
                ? `失败：${FAILED_CODE_LABELS[failedCode] ?? failedCode}`
                : '失败';
        case 'processing':
            return '处理中';
        case 'init':
            return '初始化';
        default:
            return '未知';
    }
}
</script>

<style scoped>
.metric-cell {
    line-height: 1.4;
}

.token-item {
    display: inline-flex;
    align-items: center;
    gap: 2px;
}

.token-icon {
    font-size: 12px;
}

.token-icon.input {
    color: var(--accent-primary);
}

.token-icon.output {
    color: #52c41a;
}

.token-divider {
    margin: 0 4px;
    color: #d9d9d9;
}

.metric-sub {
    font-size: 12px;
    color: #8c8c8c;
}
</style>
