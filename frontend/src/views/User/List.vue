<template>
    <div class="user-list">
        <div class="table-header">
            <a-form layout="inline">
                <a-form-item label="用户名">
                    <a-input
                        id="user-search-keyword"
                        v-model:value="searchForm.keyword"
                        name="user_search_keyword"
                        placeholder="搜索用户名"
                        allow-clear
                    />
                </a-form-item>
                <a-form-item label="类型">
                    <a-select
                        id="user-search-type"
                        v-model:value="searchForm.type"
                        placeholder="全部"
                        style="width: 120px"
                        allow-clear
                        :get-popup-container="getPopupContainer"
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
                        :formatter="balanceFormatter"
                        prefix="¥"
                        :value-style="{ color: record.balance > 0 ? 'var(--accent-primary)' : record.balance < 0 ? '#ff4d4f' : 'var(--text-secondary)', fontSize: '14px' }"
                    />
                    <a-tag v-if="record.balance < 0" color="error" style="margin-left: 8px">欠费</a-tag>
                </template>
                <template v-if="column.key === 'status'">
                    <a-tag :color="record.status === 'active' ? 'success' : 'error'">
                        {{ record.status === 'active' ? '已启用' : '已禁用' }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'action'">
                    <a-space :size="0">
                        <a-tooltip title="查看">
                            <a-button
                                type="text"
                                size="small"
                                class="user-action-button"
                                aria-label="查看"
                                @click="handleView(record)"
                            >
                                <EyeOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="编辑">
                            <a-button
                                type="text"
                                size="small"
                                class="user-action-button"
                                aria-label="编辑"
                                @click="handleEdit(record)"
                            >
                                <EditOutlined />
                            </a-button>
                        </a-tooltip>
                    </a-space>
                </template>
            </template>
        </a-table>
    </div>

    <DialogCreate ref="createDialogRef" @success="handleCreateSuccess" />
    <DialogEdit ref="editDialogRef" @success="handleEditSuccess" />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { EditOutlined, EyeOutlined } from '@ant-design/icons-vue';
import { useRouter } from 'vue-router';
import { listUsers } from '@/api/user';
import { useResourceTable } from '@/composables/useResourceTable';
import { useAppStore } from '@/stores/app';
import TokenDisplay from '@/components/common/TokenDisplay.vue';
import { formatBalance, BALANCE_SCALE } from '@/utils/format';
import DialogCreate from './DialogCreate.vue';
import DialogEdit from './DialogEdit.vue';
import type { User, UserQuery } from '@/types/user';

const router = useRouter();
const appStore = useAppStore();

// 后端返回整数微元，展示时换算为"元"
const balanceFormatter = ({ value }: { value: number }) => formatBalance(value / BALANCE_SCALE);

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

const columns = computed<TableColumnsType<User>>(() => {
    const cols: TableColumnsType<User> = [
        { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
        { title: '用户名', key: 'name', dataIndex: 'name' },
        { title: 'Token', key: 'token', dataIndex: 'token' },
        { title: '类型', key: 'type', dataIndex: 'type', width: 100 },
        { title: '启用', key: 'status', dataIndex: 'status', width: 80 },
    ];
    if (appStore.moduleBillingEnabled) {
        cols.push({ title: '余额', key: 'balance', dataIndex: 'balance', width: 150 });
    }
    cols.push({ title: '操作', key: 'action', width: 120, fixed: 'right' as const });
    return cols;
});

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


function getPopupContainer(node: HTMLElement): HTMLElement {
    return node.parentElement ?? document.body;
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

.user-action-button {
    color: var(--accent-primary);
}
</style>
