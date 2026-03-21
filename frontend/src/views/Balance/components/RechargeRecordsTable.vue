<template>
    <div class="recharge-records-table">
        <div class="table-header">
            <a-form layout="inline">
                <a-form-item label="用户ID">
                    <a-input
                        v-model:value="searchForm.user_id"
                        placeholder="请输入用户ID"
                        allow-clear
                        style="width: 150px"
                    />
                </a-form-item>
                <a-form-item label="类型">
                    <a-select
                        v-model:value="searchForm.type"
                        placeholder="全部"
                        style="width: 120px"
                        allow-clear
                    >
                        <a-select-option value="recharge">充值</a-select-option>
                        <a-select-option value="adjustment">调整</a-select-option>
                    </a-select>
                </a-form-item>
                <a-form-item>
                    <a-space>
                        <a-button type="primary" @click="handleSearch">搜索</a-button>
                        <a-button @click="handleReset">重置</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
        </div>

        <a-table
            :columns="columns"
            :data-source="data"
            :loading="loading"
            :pagination="pagination"
            @change="handleTableChange"
            :row-key="(record: RechargeRecord) => record.id"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'amount'">
                    <span :style="{ color: record.amount >= 0 ? '#52c41a' : '#ff4d4f' }">
                        {{ record.amount >= 0 ? '+' : '' }}¥{{ Math.abs(record.amount).toFixed(2) }}
                    </span>
                </template>
                <template v-if="column.key === 'type'">
                    <a-tag
                        :style="record.type === 'recharge'
                            ? undefined
                            : {
                                color: 'var(--accent-primary)',
                                backgroundColor: 'var(--accent-primary-soft)',
                                borderColor: 'var(--accent-primary-border)',
                            }"
                    >
                        {{ record.type === 'recharge' ? '充值' : '调整' }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'created_at'">
                    {{ formatDate(record.created_at) }}
                </template>
            </template>
        </a-table>
    </div>
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue';
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import { listRechargeRecords } from '@/api/billing';
import { useTable } from '@/composables/useTable';
import type { RechargeRecord, RechargeRecordsQuery } from '@/types/billing';

const props = defineProps<{
    selectedUserId?: number;
}>();

const { loading, data, pagination, searchForm, setPage, clearData } = useTable<RechargeRecord, RechargeRecordsQuery>(10, {
    user_id: undefined,
    type: undefined,
});

const columns: TableColumnsType<RechargeRecord> = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '用户ID', key: 'user_id', dataIndex: 'user_id', width: 100 },
    { title: '金额', key: 'amount', dataIndex: 'amount', width: 120 },
    { title: '类型', key: 'type', dataIndex: 'type', width: 100 },
    { title: '备注', key: 'remark', dataIndex: 'remark', ellipsis: true },
    { title: '操作人', key: 'operator', dataIndex: 'operator', width: 100 },
    { title: '时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
];

onMounted(() => {
    loadData();
});

watch(() => props.selectedUserId, (newUserId) => {
    if (newUserId !== undefined) {
        searchForm.user_id = newUserId;
        loadData();
    }
});

async function loadData() {
    loading.value = true;
    try {
        const params: RechargeRecordsQuery = {};
        if (searchForm.user_id) {
            params.user_id = searchForm.user_id;
        }
        if (searchForm.type) {
            params.type = searchForm.type;
        }

        const result = await listRechargeRecords(params);
        data.value = result;
        pagination.total = result.length;
    } catch (error) {
        console.error('加载充值记录失败:', error);
    } finally {
        loading.value = false;
    }
}

function handleSearch() {
    pagination.current = 1;
    clearData();
    loadData();
}

function handleReset() {
    searchForm.user_id = undefined;
    searchForm.type = undefined;
    pagination.current = 1;
    pagination.pageSize = 10;
    clearData();
    loadData();
}

function handleTableChange(pag: TablePaginationConfig) {
    setPage(pag.current ?? 1, pag.pageSize ?? pagination.pageSize);
}

function formatDate(dateStr: string | number | null): string {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}
</script>

<style scoped>
.recharge-records-table {
    padding: 24px;
}

.table-header {
    margin-bottom: 16px;
}
</style>
