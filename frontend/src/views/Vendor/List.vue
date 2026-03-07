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
                        <a-select-option value="openai">OpenAI</a-select-option>
                        <a-select-option value="anthropic">Anthropic</a-select-option>
                        <a-select-option value="google">Google</a-select-option>
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
                    <a-tag :color="getTypeColor(record.type)">
                        {{ getTypeLabel(record.type) }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'action'">
                    <a-space>
                        <a-button type="link" @click="handleEdit(record)">
                            编辑
                        </a-button>
                        <a-button type="link" @click="handleView(record)">
                            查看
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
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { listVendors } from '@/api/vendor';
import { useTable } from '@/composables/useTable';
import DialogCreate from './DialogCreate.vue';
import DialogEdit from './DialogEdit.vue';
import type { Vendor, VendorType } from '@/types/vendor';

const router = useRouter();

const { loading, data, pagination, searchForm, setPage } = useTable<Vendor>();

const createDialogRef = ref();
const editDialogRef = ref();

const columns = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '类型', key: 'type', dataIndex: 'type', width: 120 },
    { title: '名称', key: 'name', dataIndex: 'name' },
    { title: '创建时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 120, fixed: 'right' as const },
];

onMounted(() => {
    loadData();
});

async function loadData() {
    loading.value = true;
    try {
        const result = await listVendors(searchForm);
        data.value = result;
        pagination.total = result.length;
    } catch (error) {
        console.error('加载供应商列表失败:', error);
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

function handleEdit(record: Vendor) {
    editDialogRef.value?.open(record);
}

function handleEditSuccess() {
    loadData();
}

function handleView(record: Vendor) {
    router.push(`/vendor/${record.id}`);
}

function getTypeLabel(type: VendorType): string {
    const labels: Record<VendorType, string> = {
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google',
    };
    return labels[type] || type;
}

function getTypeColor(type: VendorType): string {
    const colors: Record<VendorType, string> = {
        openai: 'green',
        anthropic: 'orange',
        google: 'blue',
    };
    return colors[type] || 'default';
}
</script>

<style scoped>
.vendor-list {
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
