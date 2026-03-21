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
                    <a-tag
                        :style="record.type === 'admin'
                            ? {
                                color: 'var(--accent-danger)',
                                backgroundColor: 'var(--accent-danger-soft)',
                                borderColor: 'var(--accent-danger-border)',
                            }
                            : {
                                color: 'var(--accent-primary)',
                                backgroundColor: 'var(--accent-primary-soft)',
                                borderColor: 'var(--accent-primary-border)',
                            }"
                    >
                        {{ record.type === 'admin' ? '管理员' : '普通用户' }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'balance'">
                    <a-statistic
                        :value="record.balance"
                        :precision="2"
                        prefix="¥"
                        :value-style="{ color: record.balance > 0 ? 'var(--accent-primary)' : record.balance < 0 ? '#ff4d4f' : 'var(--text-secondary)', fontSize: '14px' }"
                    />
                </template>
                <template v-if="column.key === 'action'">
                    <a-space>
                        <a-button type="link" @click="handleView(record)">
                            查看
                        </a-button>
                        <a-button type="link" @click="handleEdit(record)">
                            编辑
                        </a-button>
                    </a-space>
                </template>
            </template>
        </a-table>
    </div>

    <DialogCreate ref="createDialogRef" @success="handleCreateSuccess" />
    <DialogEdit ref="editDialogRef" @success="handleEditSuccess" />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { useRouter } from 'vue-router';
import { listUsers } from '@/api/user';
import { useResourceTable } from '@/composables/useResourceTable';
import TokenDisplay from '@/components/common/TokenDisplay.vue';
import DialogCreate from './DialogCreate.vue';
import DialogEdit from './DialogEdit.vue';
import type { User, UserQuery } from '@/types/user';

const router = useRouter();

const { loading, data, pagination, searchForm, loadData, handleSearch, handleReset, handleTableChange } = useResourceTable<User, UserQuery>({
    initialSearchForm: {
        keyword: undefined,
        type: undefined,
    },
    fetcher: listUsers,
    resetSearchForm: (form) => {
        form.keyword = undefined;
        form.type = undefined;
    },
});

const createDialogRef = ref();
const editDialogRef = ref();

const columns: TableColumnsType<User> = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '用户名', key: 'name', dataIndex: 'name' },
    { title: 'Token', key: 'token', dataIndex: 'token' },
    { title: '类型', key: 'type', dataIndex: 'type', width: 100 },
    { title: '余额', key: 'balance', dataIndex: 'balance', width: 150 },
    { title: '操作', key: 'action', width: 120, fixed: 'right' as const },
];

function handleCreate() {
    createDialogRef.value?.open();
}

function handleCreateSuccess() {
    loadData();
}

function handleView(record: User) {
    router.push(`/user/${record.id}`);
}

function handleEdit(record: User) {
    editDialogRef.value?.open(record);
}

function handleEditSuccess() {
    loadData();
}
</script>

<style scoped>
.user-list {
    background: var(--bg-page);
    padding: 24px;
}

.table-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
}
</style>
