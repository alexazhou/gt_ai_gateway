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
            <template #headerCell="{ column }">
                <template v-if="column.key === 'price'">
                    <span style="display: flex; align-items: center; gap: 4px;">
                        价格
                        <a-tooltip title="元/千tokens">
                            <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                        </a-tooltip>
                    </span>
                </template>
            </template>
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'vendor_id'">
                    {{ getVendorName(record.vendor_id) }}
                </template>
                <template v-if="column.key === 'enable'">
                    <a-tag :color="Boolean(record.enable) ? 'green' : 'red'">
                        {{ Boolean(record.enable) ? '启用' : '禁用' }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'price'">
                    <div class="price-display">
                        <div class="price-row">
                            <ArrowUpOutlined class="price-icon input" />
                            <span>¥{{ (record.input_price || 0).toFixed(6) }}</span>
                        </div>
                        <div class="price-row">
                            <ArrowDownOutlined class="price-icon output" />
                            <span>¥{{ (record.output_price || 0).toFixed(6) }}</span>
                        </div>
                    </div>
                </template>
                <template v-if="column.key === 'created_at'">
                    {{ formatDate(record.created_at) }}
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
import type { TableColumnsType } from 'ant-design-vue';
import { useRouter } from 'vue-router';
import { ArrowUpOutlined, ArrowDownOutlined, InfoCircleOutlined } from '@ant-design/icons-vue';
import { listModels } from '@/api/model';
import { listVendors } from '@/api/vendor';
import { useResourceTable } from '@/composables/useResourceTable';
import { formatDate } from '@/utils/format';
import DialogCreate from './DialogCreate.vue';
import DialogEdit from './DialogEdit.vue';
import type { Model, ModelQuery } from '@/types/model';
import type { Vendor as VendorType } from '@/types/vendor';

const router = useRouter();

const { loading, data, pagination, searchForm, loadData, handleSearch, handleReset, handleTableChange } = useResourceTable<Model, ModelQuery>({
    initialSearchForm: {
        keyword: undefined,
        vendor_id: undefined,
    },
    fetcher: listModels,
    resetSearchForm: (form) => {
        form.keyword = undefined;
        form.vendor_id = undefined;
    },
});

const createDialogRef = ref();
const editDialogRef = ref();

const vendors = ref<VendorType[]>([]);
const vendorsLoading = ref(false);

const columns: TableColumnsType<Model> = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '模型名称', key: 'name', dataIndex: 'name' },
    { title: '所属供应商', key: 'vendor_id', dataIndex: 'vendor_id', width: 150 },
    { title: '状态', key: 'enable', dataIndex: 'enable', width: 100 },
    { title: '价格', key: 'price', width: 180 },
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
    void loadVendors();
});

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
    background: var(--bg-page);
    padding: 24px;
}

.table-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
}

.price-display {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.price-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
}

.price-icon {
    font-size: 12px;
}

.price-icon.input {
    color: var(--accent-primary);
}

.price-icon.output {
    color: #52c41a;
}
</style>
