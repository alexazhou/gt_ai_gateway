<template>
    <div class="user-balance-table">
        <div class="table-header">
            <a-form layout="inline">
                <a-form-item label="用户名">
                    <a-input
                        v-model:value="searchForm.keyword"
                        placeholder="搜索用户名"
                        allow-clear
                        style="width: 200px"
                    />
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
            :row-key="(record: User) => record.id"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'token'">
                    <TokenDisplay :token="record.token" />
                </template>
                <template v-if="column.key === 'type'">
                    <a-tag :color="record.type === 'admin' ? 'red' : 'blue'">
                        {{ record.type === 'admin' ? '管理员' : '普通用户' }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'balance'">
                    <a-statistic
                        :value="record.balance"
                        :precision="2"
                        prefix="¥"
                        :value-style="{ color: record.balance > 0 ? '#1677ff' : record.balance < 0 ? '#ff4d4f' : '#8c8c8c', fontSize: '14px' }"
                    />
                </template>
                <template v-if="column.key === 'action'">
                    <a-space>
                        <a-button type="primary" size="small" @click="handleAdjust(record)">
                            调整余额
                        </a-button>
                    </a-space>
                </template>
            </template>
        </a-table>
    </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { listUsers } from '@/api/user';
import { useTable } from '@/composables/useTable';
import TokenDisplay from '@/components/common/TokenDisplay.vue';
import type { User } from '@/types/user';

const emit = defineEmits<{
    adjust: [user: User];
}>();

const { loading, data, pagination, searchForm, setPage, clearData } = useTable<User>();

const columns = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '用户名', key: 'name', dataIndex: 'name' },
    { title: '类型', key: 'type', dataIndex: 'type', width: 100 },
    { title: '余额', key: 'balance', dataIndex: 'balance', width: 150 },
    { title: '操作', key: 'action', width: 100, fixed: 'right' as const },
];

onMounted(() => {
    loadData();
});

async function loadData() {
    loading.value = true;
    try {
        const result = await listUsers(searchForm);
        data.value = result;
        pagination.total = result.length;
    } catch (error) {
        console.error('加载用户列表失败:', error);
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
    searchForm.keyword = undefined;
    pagination.current = 1;
    pagination.pageSize = 10;
    clearData();
    loadData();
}

function handleTableChange(pag: any) {
    setPage(pag.current, pag.pageSize);
}

function handleAdjust(record: User) {
    emit('adjust', record);
}
</script>

<style scoped>
.user-balance-table {
    padding: 24px;
}

.table-header {
    margin-bottom: 16px;
}
</style>