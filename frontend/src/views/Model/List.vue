<template>
    <div class="model-list">
        <div class="table-header">
            <a-form layout="inline">
                <a-form-item label="模型名称">
                    <a-input
                        v-model:value="searchForm.keyword"
                        placeholder="搜索模型名称"
                        allow-clear
                    />
                </a-form-item>
                <a-form-item label="供应商">
                    <a-select
                        v-model:value="searchForm.vendor_id"
                        placeholder="全部"
                        style="width: 150px"
                        allow-clear
                        :loading="vendorsLoading"
                    >
                        <a-select-option
                            v-for="vendor in vendors"
                            :key="vendor.id"
                            :value="vendor.id"
                        >
                            {{ vendor.name }}
                        </a-select-option>
                    </a-select>
                </a-form-item>
                <a-form-item>
                    <a-space>
                        <a-button type="primary" @click="handleSearch">搜索</a-button>
                        <a-button @click="handleReset">重置</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
            <a-button type="primary" @click="handleCreate">新建模型</a-button>
        </div>

        <a-table
            :columns="columns"
            :data-source="data"
            :loading="loading"
            :pagination="pagination"
            @change="handleTableChange"
            :row-key="(record: Model) => record.id"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'vendor_id'">
                    {{ getVendorName(record.vendor_id) }}
                </template>
                <template v-if="column.key === 'enable'">
                    <a-tag :color="record.enable ? 'green' : 'red'">
                        {{ record.enable ? '启用' : '禁用' }}
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
import { listModels } from '@/api/model';
import { listVendors } from '@/api/vendor';
import { useTable } from '@/composables/useTable';
import DialogCreate from './DialogCreate.vue';
import DialogEdit from './DialogEdit.vue';
import type { Model } from '@/types/model';
import type { Vendor as VendorType } from '@/types/vendor';

const router = useRouter();

const { loading, data, pagination, searchForm, setPage } = useTable<Model>();

const createDialogRef = ref();
const editDialogRef = ref();

const vendors = ref<VendorType[]>([]);
const vendorsLoading = ref(false);

const columns = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '模型名称', key: 'name', dataIndex: 'name' },
    { title: '所属供应商', key: 'vendor_id', dataIndex: 'vendor_id', width: 150 },
    { title: '状态', key: 'enable', dataIndex: 'enable', width: 100 },
    { title: '创建时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 120, fixed: 'right' as const },
];

async function loadVendors() {
    vendorsLoading.value = true;
    try {
        vendors.value = await listVendors();
    } catch (error) {
        console.error('加载供应商列表失败:', error);
    } finally {
        vendorsLoading.value = false;
    }
}

onMounted(() => {
    loadVendors();
    loadData();
});

async function loadData() {
    loading.value = true;
    try {
        const result = await listModels(searchForm);
        data.value = result;
        pagination.total = result.length;
    } catch (error) {
        console.error('加载模型列表失败:', error);
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
    searchForm.vendor_id = undefined;
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

function handleEdit(record: Model) {
    editDialogRef.value?.open(record);
}

function handleEditSuccess() {
    loadData();
}

function handleView(record: Model) {
    router.push(`/model/${record.id}`);
}

function getVendorName(vendorId: number): string {
    const vendor = vendors.value.find(v => v.id === vendorId);
    return vendor ? vendor.name : `ID: ${vendorId}`;
}
</script>

<style scoped>
.model-list {
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
