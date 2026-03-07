<template>
    <div class="user-list">
        <div class="table-header">
            <a-form layout="inline">
                <a-form-item label="用户名">
                    <a-input
                        v-model:value="searchForm.keyword"
                        placeholder="搜索用户名"
                        allow-clear
                    />
                </a-form-item>
                <a-form-item label="类型">
                    <a-select
                        v-model:value="searchForm.type"
                        placeholder="全部"
                        style="width: 120px"
                        allow-clear
                    >
                        <a-select-option value="normal">普通用户</a-select-option>
                        <a-select-option value="admin">管理员</a-select-option>
                    </a-select>
                </a-form-item>
                <a-form-item>
                    <a-space>
                        <a-button type="primary" @click="handleSearch">搜索</a-button>
                        <a-button @click="handleReset">重置</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
            <a-button type="primary" @click="handleCreate">新建用户</a-button>
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
                <template v-if="column.key === 'action'">
                    <a-button type="link" @click="handleView(record)">
                        查看
                    </a-button>
                </template>
            </template>
        </a-table>
    </div>

    <DialogCreate ref="createDialogRef" @success="handleCreateSuccess" />
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { listUsers } from '@/api/user';
import { useTable } from '@/composables/useTable';
import TokenDisplay from '@/components/common/TokenDisplay.vue';
import DialogCreate from './DialogCreate.vue';
import type { User } from '@/types/user';

const router = useRouter();

const { loading, data, pagination, searchForm, setPage } = useTable<User>();

const createDialogRef = ref();

const columns = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '用户名', key: 'name', dataIndex: 'name' },
    { title: 'Token', key: 'token', dataIndex: 'token' },
    { title: '类型', key: 'type', dataIndex: 'type', width: 100 },
    { title: '操作', key: 'action', width: 80, fixed: 'right' as const },
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
    loadData();
}

function handleReset() {
    searchForm.keyword = undefined;
    searchForm.type = undefined;
    pagination.current = 1;
    pagination.pageSize = 10;
    loadData();
}

function handleTableChange(pag: any) {
    setPage(pag.current, pag.pageSize);
}

function handleCreate() {
    createDialogRef.value?.open();
}

function handleCreateSuccess() {
    loadData();
}

function handleView(record: User) {
    router.push(`/user/${record.id}`);
}
</script>

<style scoped>
.user-list {
    background: #fff;
    padding: 24px;
}

.table-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
}
</style>
