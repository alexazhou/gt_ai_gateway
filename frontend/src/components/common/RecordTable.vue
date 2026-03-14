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
                    {{ getStatusText(record.status) }}
                </a-tag>
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
import { useRouter } from 'vue-router';
import { formatDate } from '@/utils/format';
import type { Record } from '@/types/record';

interface Props {
    records: Record[];
    loading?: boolean;
    pagination?: any;
    size?: 'small' | 'middle' | 'default';
    columns?: any[];
}

const props = withDefaults(defineProps<Props>(), {
    loading: false,
    pagination: false,
    size: 'default',
});

const emit = defineEmits<{
    change: [pagination: any];
}>();

const router = useRouter();

const defaultColumns = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '用户', key: 'user_name', dataIndex: 'user_name' },
    { title: '供应商', key: 'vendor_name', dataIndex: 'vendor_name' },
    { title: '模型', key: 'model_name', dataIndex: 'model_name' },
    { title: '状态', key: 'status', dataIndex: 'status', width: 100 },
    { title: '创建时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 80, fixed: 'right' as const },
];

const displayColumns = computed(() => {
    return props.columns || defaultColumns;
});

function handleTableChange(pag: any) {
    emit('change', pag);
}

function handleView(record: Record) {
    router.push(`/record/${record.id}`);
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

function getStatusText(status: string | null): string {
    switch (status) {
        case 'success':
            return '成功';
        case 'failed':
            return '失败';
        case 'processing':
            return '处理中';
        case 'init':
            return '初始化';
        default:
            return '未知';
    }
}
</script>
