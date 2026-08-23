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
            :scroll="{ x: 'max-content' }"
        >
            <template #headerCell="{ column }">
                <template v-if="column.key === 'price'">
                    <span style="display: flex; align-items: center; gap: 4px;">
                        价格
                        <a-tooltip title="元/百万 tokens">
                            <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                        </a-tooltip>
                    </span>
                </template>
                <template v-else-if="column.key === 'upstream_model'">
                    <span style="display: flex; align-items: center; gap: 4px;">
                        上游模型
                        <a-tooltip title="供应商/模型">
                            <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                        </a-tooltip>
                    </span>
                </template>
            </template>
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'upstream_model'">
                    <a-space direction="vertical" size="small">
                        <UpstreamModel
                            v-for="(upstream, index) in record.routing_config.upstreams"
                            :key="`${upstream.vendor_id}-${upstream.vendor_model_id ?? 'auto'}-${index}`"
                            :vendor-name="getVendorName(upstream.vendor_id)"
                            :model-name="upstream.vendor_model_id ? getVendorModelName(upstream.vendor_model_id) : 'auto'"
                            :auto-mapped="!upstream.vendor_model_id"
                            :disabled="!upstream.enabled"
                        />
                    </a-space>
                </template>
                <template v-if="column.key === 'enable'">
                    <a-space :size="4">
                        <a-tag :color="Boolean(record.enable) ? 'green' : 'red'">
                            {{ Boolean(record.enable) ? '启用' : '禁用' }}
                        </a-tag>
                        <a-tag v-if="isSharedModel(record)" color="purple">共享</a-tag>
                    </a-space>
                </template>
                <template v-if="column.key === 'price'">
                    <a-tag 
                        :color="((record.prices?.input || 0) > 0 || (record.prices?.output || 0) > 0 || (record.prices?.cache_read || 0) > 0) ? 'blue' : 'default'"
                        :style="{ color: ((record.prices?.input || 0) > 0 || (record.prices?.output || 0) > 0 || (record.prices?.cache_read || 0) > 0) ? undefined : '#999' }"
                    >
                        {{ ((record.prices?.input || 0) > 0 || (record.prices?.output || 0) > 0 || (record.prices?.cache_read || 0) > 0) ? '已配置' : '未配置' }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'created_at'">
                    {{ formatDate(record.created_at) }}
                </template>
                <template v-if="column.key === 'action'">
                    <a-space :size="0">
                        <a-tooltip title="编辑">
                            <a-button
                                type="text"
                                size="small"
                                class="model-action-button"
                                aria-label="编辑"
                                :disabled="isSharedModel(record)"
                                @click="handleEdit(record)"
                            >
                                <EditOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="查看">
                            <a-button
                                type="text"
                                size="small"
                                class="model-action-button"
                                aria-label="查看"
                                @click="handleView(record)"
                            >
                                <EyeOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="测试">
                            <a-button
                                type="text"
                                size="small"
                                class="model-action-button"
                                aria-label="测试"
                                @click="handleTest(record)"
                            >
                                <ExperimentOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="删除">
                            <a-button
                                danger
                                type="text"
                                size="small"
                                aria-label="删除"
                                :disabled="isSharedModel(record)"
                                @click="handleDelete(record)"
                            >
                                <DeleteOutlined />
                            </a-button>
                        </a-tooltip>
                    </a-space>
                </template>
            </template>
        </a-table>
    </div>

    <DialogForm ref="dialogFormRef" @success="handleSuccess" />
    <DialogTest ref="testDialogRef" />
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { Modal } from 'ant-design-vue/es';
import {
    DeleteOutlined,
    EditOutlined,
    ExperimentOutlined,
    EyeOutlined,
    InfoCircleOutlined,
} from '@ant-design/icons-vue';
import { deleteModel, listModels } from '@/api/model';
import { listVendors, fetchVendorModelsByIds } from '@/api/vendor';
import { getConfig } from '@/api/config';
import { useResourceTable } from '@/composables/useResourceTable';
import { useTenantStore } from '@/stores/tenant';
import { useAppStore } from '@/stores/app';
import { formatDate } from '@/utils/format';
import { normalizeListResponse } from '@/utils/listResponse';
import DialogForm from './DialogForm.vue';
import DialogTest from '@/views/Vendor/DialogTest.vue';
import UpstreamModel from './UpstreamModel.vue';
import type { Model, ModelQuery } from '@/types/model';
import type { Vendor as VendorType, VendorModel } from '@/types/vendor';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const tenantStore = useTenantStore();
const appStore = useAppStore();

// 当前视角租户 id（root 取切换的视角；admin 取自身租户；root 未切换时缺省 main）
const myTenantId = computed(() => tenantStore.currentTenantIdNum ?? appStore.tenantId ?? appStore.mainTenantId);

// 共享模型识别：main 租户模型 cross_tenant=1，且不属于当前视角租户 → 只读
function isSharedModel(record: Model): boolean {
    return Boolean(record.cross_tenant)
        && typeof record.tenant_id === 'number'
        && myTenantId.value !== null
        && record.tenant_id !== myTenantId.value;
}

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

const dialogFormRef = ref<InstanceType<typeof DialogForm>>();
const testDialogRef = ref<InstanceType<typeof DialogTest>>();

const vendors = ref<VendorType[]>([]);
const vendorsLoading = ref(false);
const vendorModelsMap = ref<Map<number, VendorModel>>(new Map());
const moduleBillingEnabled = ref(false);

const columns = computed<TableColumnsType<Model>>(() => {
    const cols: TableColumnsType<Model> = [
        { title: 'ID', key: 'id', dataIndex: 'id' },
        { title: '模型名称', key: 'name', dataIndex: 'name' },
        { title: '上游模型', key: 'upstream_model' },
        { title: '状态', key: 'enable', dataIndex: 'enable' },
    ];
    if (moduleBillingEnabled.value) {
        cols.push({ title: '价格', key: 'price' });
    }
    cols.push(
        { title: '创建时间', key: 'created_at', dataIndex: 'created_at' },
        { title: '操作', key: 'action', width: 120, fixed: 'right' as const },
    );
    return cols;
});

async function loadVendors() {
    vendorsLoading.value = true;
    try {
        vendors.value = normalizeListResponse(await listVendors({ page: 1, pageSize: 1000 })).list;
    } catch (error) {
        console.error('加载供应商列表失败:', error);
    } finally {
        vendorsLoading.value = false;
    }
}

onMounted(() => {
    void loadVendors();
    getConfig().then(config => {
        moduleBillingEnabled.value = config.module_billing_enabled === 'true';
    });
});

function handleCreate() {
    dialogFormRef.value?.openCreate();
}

function handleEdit(record: Model) {
    dialogFormRef.value?.openEdit(record);
}

function handleSuccess() {
    loadData();
}

function handleView(record: Model) {
    dialogFormRef.value?.openView(record);
}

function handleTest(record: Model) {
    testDialogRef.value?.openModelTest(record.name);
}

function handleDelete(record: Model) {
    Modal.confirm({
        title: '确认删除',
        content: `确定要删除模型 "${record.name}" 吗？`,
        okText: '确定',
        cancelText: '取消',
        okType: 'danger',
        onOk: async () => {
            try {
                await deleteModel(record.id);
                notifySuccess('删除成功');
                void loadData();
            } catch (error) {
                notifyRequestError(error, '删除失败');
            }
        },
    });
}

function getVendorName(vendorId: number): string {
    const vendor = vendors.value.find(v => v.id === vendorId);
    return vendor ? vendor.name : `ID: ${vendorId}`;
}

function getVendorModelName(id: number): string {
    return vendorModelsMap.value.get(id)?.model_id ?? `#${id}`;
}

async function loadVendorModelsForPage(models: Model[]) {
    const ids = [...new Set(models.flatMap(model => (
        model.routing_config.upstreams
            .map(upstream => upstream.vendor_model_id)
            .filter((id): id is number => id != null)
    )))];
    if (ids.length === 0) return;
    try {
        const vms = await fetchVendorModelsByIds(ids);
        vms.forEach((vm: VendorModel) => vendorModelsMap.value.set(vm.id, vm));
    } catch {
        // ignore
    }
}

watch(data, (models) => {
    if (models.length > 0) void loadVendorModelsForPage(models);
});
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

.model-action-button {
    color: var(--accent-primary);
}

</style>
