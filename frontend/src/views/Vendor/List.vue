<template>
    <div class="vendor-list">
        <div class="table-header">
            <a-form layout="inline">
                <a-form-item label="名称">
                    <a-input
                        v-model:value="searchForm.keyword"
                        placeholder="搜索供应商名称"
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
                        <a-select-option value="aliyun">Aliyun (通义千问)</a-select-option>
                        <a-select-option value="aliyun_coding">Aliyun Coding</a-select-option>
                        <a-select-option value="volcengine_coding">Volcengine Coding</a-select-option>
                        <a-select-option value="deepseek">DeepSeek</a-select-option>
                        <a-select-option value="openai">OpenAI</a-select-option>
                        <a-select-option value="anthropic">Anthropic</a-select-option>
                        <a-select-option value="google">Google</a-select-option>
                        <a-select-option value="other">Other</a-select-option>
                    </a-select>
                </a-form-item>
                <a-form-item>
                    <a-space>
                        <a-button type="primary" @click="handleSearch">搜索</a-button>
                        <a-button @click="handleReset">重置</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
            <a-button type="primary" @click="handleCreate">新建供应商</a-button>
        </div>

        <a-table
            :columns="columns"
            :data-source="data"
            :loading="loading"
            :pagination="pagination"
            @change="handleTableChange"
            :row-key="(record: Vendor) => record.id"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'type'">
                    <a-tag :color="getTypeColor(record.type)" :style="getTypeTagStyle(record.type)">
                        {{ getTypeLabel(record.type) }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'created_at'">
                    {{ formatDate(record.created_at) }}
                </template>
                <template v-if="column.key === 'action'">
                    <a-space>
                        <a-button type="link" @click="handleEdit(record)">
                            编辑
                        </a-button>
                        <a-button type="link" @click="handleTest(record)">
                            测试
                        </a-button>
                        <a-button type="link" @click="handleView(record)">
                            查看
                        </a-button>
                        <a-button type="link" danger @click="handleDelete(record)">
                            删除
                        </a-button>
                    </a-space>
                </template>
            </template>
        </a-table>
    </div>

    <DialogCreate ref="createDialogRef" @success="handleCreateSuccess" />
    <DialogEdit ref="editDialogRef" @success="handleEditSuccess" />
    <DialogTest ref="testDialogRef" />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { useRouter } from 'vue-router';
import { Modal } from 'ant-design-vue/es';
import { listVendors, deleteVendor } from '@/api/vendor';
import { useResourceTable } from '@/composables/useResourceTable';
import { formatDate } from '@/utils/format';
import DialogCreate from './DialogCreate.vue';
import DialogEdit from './DialogEdit.vue';
import DialogTest from './DialogTest.vue';
import type { Vendor, VendorQuery, VendorType } from '@/types/vendor';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const router = useRouter();

const { loading, data, pagination, searchForm, loadData, handleSearch, handleReset, handleTableChange } = useResourceTable<Vendor, VendorQuery>({
    initialSearchForm: {
        keyword: undefined,
        type: undefined,
    },
    fetcher: listVendors,
    resetSearchForm: (form) => {
        form.keyword = undefined;
        form.type = undefined;
    },
});

const createDialogRef = ref();
const editDialogRef = ref();
const testDialogRef = ref();

const columns: TableColumnsType<Vendor> = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '类型', key: 'type', dataIndex: 'type', width: 120 },
    { title: '名称', key: 'name', dataIndex: 'name' },
    { title: '创建时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 180, fixed: 'right' as const },
];

function handleCreate() {
    createDialogRef.value?.open();
}

function handleCreateSuccess() {
    loadData();
}

function handleEdit(record: Vendor) {
    editDialogRef.value?.open(record);
}

function handleEditSuccess() {
    loadData();
}

function handleTest(record: Vendor) {
    testDialogRef.value?.open(record);
}

function handleView(record: Vendor) {
    router.push(`/vendor/${record.id}`);
}

function handleDelete(record: Vendor) {
    Modal.confirm({
        title: '确认删除',
        content: `确定要删除供应商 "${record.name}" 吗？`,
        okText: '确定',
        cancelText: '取消',
        okType: 'danger',
        onOk: async () => {
            try {
                await deleteVendor(record.id);
                notifySuccess('删除成功');
                void loadData();
            } catch (error) {
                notifyRequestError(error, '删除失败');
            }
        },
    });
}

function getTypeLabel(type: VendorType): string {
    const labels: Record<VendorType, string> = {
        aliyun: 'Aliyun (通义千问)',
        aliyun_coding: 'Aliyun Coding',
        volcengine_coding: 'Volcengine Coding',
        deepseek: 'DeepSeek',
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google',
        other: 'Other',
    };
    return labels[type] || type;
}

function getTypeColor(type: VendorType): string {
    const colors: Record<VendorType, string> = {
        aliyun: 'orange',
        aliyun_coding: 'orange',
        volcengine_coding: 'purple',
        deepseek: '',
        openai: 'green',
        anthropic: 'orange',
        google: '',
        other: 'default',
    };
    return colors[type] || 'default';
}

function getTypeTagStyle(type: VendorType) {
    if (type === 'deepseek' || type === 'google') {
        return {
            color: 'var(--accent-primary)',
            backgroundColor: 'var(--accent-primary-soft)',
            borderColor: 'var(--accent-primary-border)',
        };
    }
    return undefined;
}
</script>

<style scoped>
.vendor-list {
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
