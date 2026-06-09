<template>
    <div class="vendor-models">
        <a-breadcrumb class="page-breadcrumb">
            <a-breadcrumb-item>
                <a @click.prevent="handleBack">供应商管理</a>
            </a-breadcrumb-item>
            <a-breadcrumb-item>{{ vendorName }}</a-breadcrumb-item>
            <a-breadcrumb-item>供应商模型</a-breadcrumb-item>
        </a-breadcrumb>

        <a-card>
            <div class="card-toolbar">
                <span class="model-count">共 {{ models.length }} 个模型</span>
                <a-space>
                    <a-button @click="addModalVisible = true">手动添加</a-button>
                    <a-button type="primary" :loading="fetchLoading" @click="handleFetch">
                        自动获取
                    </a-button>
                </a-space>
            </div>

            <a-table
                :columns="columns"
                :data-source="models"
                :loading="listLoading"
                :pagination="false"
                row-key="id"
                size="small"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'created_at'">
                        {{ formatDate(record.created_at) }}
                    </template>
                    <template v-if="column.key === 'action'">
                        <a-button type="link" danger size="small" @click="handleDelete(record)">
                            删除
                        </a-button>
                    </template>
                </template>
            </a-table>
        </a-card>

        <!-- 手动添加模型弹窗 -->
        <a-modal
            v-model:open="addModalVisible"
            title="手动添加模型"
            :confirm-loading="addLoading"
            @ok="handleManualAdd"
            @cancel="addModalVisible = false; manualModelId = ''"
        >
            <a-form layout="vertical" style="margin-top: 8px">
                <a-form-item label="Model ID">
                    <a-input
                        v-model:value="manualModelId"
                        placeholder="例如：deepseek-v4-pro"
                        allow-clear
                        @pressEnter="handleManualAdd"
                    />
                </a-form-item>
            </a-form>
        </a-modal>

        <!-- 从供应商获取模型的确认弹窗 -->
        <a-modal
            v-model:open="syncModalVisible"
            title="选择要保存的模型"
            width="600px"
            :confirm-loading="syncLoading"
            @ok="handleSyncConfirm"
            @cancel="syncModalVisible = false"
        >
            <div v-if="fetchedModels.length === 0" class="empty-hint">
                未获取到模型列表
            </div>
            <template v-else>
                <div class="select-actions">
                    <a-button size="small" type="link" @click="selectAll">全选</a-button>
                    <a-button size="small" type="link" @click="selectNone">全不选</a-button>
                    <span class="selected-count">已选 {{ selectedModelIds.length }} / {{ fetchedModels.length }}</span>
                </div>
                <a-input
                    v-model:value="modelSearch"
                    placeholder="搜索模型名称"
                    allow-clear
                    class="model-search"
                />
                <div class="model-checkbox-group">
                    <template v-for="modelId in filteredModels" :key="modelId">
                        <div class="model-checkbox-item" @click="toggleModel(modelId, !selectedModelIds.includes(modelId))">
                            <a-checkbox
                                :checked="selectedModelIds.includes(modelId)"
                                @change="(e: Event) => { e.stopPropagation(); toggleModel(modelId, (e.target as HTMLInputElement).checked); }"
                                @click.stop
                            />
                            <span class="model-checkbox-label">{{ modelId }}</span>
                        </div>
                    </template>
                    <div v-if="filteredModels.length === 0" class="empty-hint">
                        无匹配结果
                    </div>
                </div>
            </template>
        </a-modal>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TableColumnsType } from 'ant-design-vue';
import { Modal } from 'ant-design-vue/es';
import { getVendor, listVendorModels, fetchVendorModels, syncVendorModels, addVendorModel, deleteVendorModel } from '@/api/vendor';
import { formatDate } from '@/utils/format';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';
import type { VendorModel } from '@/types/vendor';

const route = useRoute();
const router = useRouter();

const vendorId = Number(route.params.id);
const vendorName = ref('');
const models = ref<VendorModel[]>([]);
const listLoading = ref(false);
const fetchLoading = ref(false);
const syncLoading = ref(false);

const manualModelId = ref('');
const addLoading = ref(false);
const addModalVisible = ref(false);

const syncModalVisible = ref(false);
const fetchedModels = ref<string[]>([]);
const selectedModelIds = ref<string[]>([]);
const modelSearch = ref('');

const filteredModels = computed(() =>
    modelSearch.value
        ? fetchedModels.value.filter(id => id.toLowerCase().includes(modelSearch.value.toLowerCase()))
        : fetchedModels.value,
);

const columns: TableColumnsType<VendorModel> = [
    { title: 'Model ID', key: 'model_id', dataIndex: 'model_id' },
    { title: '添加时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 80, fixed: 'right' as const },
];

onMounted(async () => {
    await Promise.all([loadVendorName(), loadModels()]);
});

async function loadVendorName() {
    try {
        const vendor = await getVendor(vendorId);
        vendorName.value = vendor.name;
    } catch {
        vendorName.value = `供应商 ${vendorId}`;
    }
}

async function loadModels() {
    listLoading.value = true;
    try {
        models.value = await listVendorModels(vendorId);
    } catch (error) {
        notifyRequestError(error, '加载模型列表失败');
    } finally {
        listLoading.value = false;
    }
}

async function handleManualAdd() {
    const id = manualModelId.value.trim();
    if (!id) return;
    addLoading.value = true;
    try {
        await addVendorModel(vendorId, id);
        notifySuccess('添加成功');
        manualModelId.value = '';
        addModalVisible.value = false;
        await loadModels();
    } catch (error) {
        notifyRequestError(error, '添加失败');
    } finally {
        addLoading.value = false;
    }
}


async function handleFetch() {
    fetchLoading.value = true;
    try {
        const result = await fetchVendorModels(vendorId);
        fetchedModels.value = result.models;
        // 默认预选已保存的模型
        const savedIds = new Set(models.value.map(m => m.model_id));
        selectedModelIds.value = result.models.filter(id => savedIds.has(id));
        modelSearch.value = '';
        syncModalVisible.value = true;
    } catch (error) {
        notifyRequestError(error, '获取模型列表失败');
    } finally {
        fetchLoading.value = false;
    }
}

async function handleSyncConfirm() {
    syncLoading.value = true;
    try {
        models.value = await syncVendorModels(vendorId, selectedModelIds.value);
        notifySuccess('模型已同步');
        syncModalVisible.value = false;
    } catch (error) {
        notifyRequestError(error, '保存失败');
    } finally {
        syncLoading.value = false;
    }
}

function handleDelete(record: VendorModel) {
    Modal.confirm({
        title: '确认删除',
        content: `确定要删除模型 ${record.model_id} 吗？`,
        okType: 'danger',
        async onOk() {
            try {
                await deleteVendorModel(vendorId, record.id);
                notifySuccess('删除成功');
                await loadModels();
            } catch (error) {
                notifyRequestError(error, '删除失败');
            }
        },
    });
}

function toggleModel(modelId: string, checked: boolean) {
    if (checked) {
        if (!selectedModelIds.value.includes(modelId)) {
            selectedModelIds.value = [...selectedModelIds.value, modelId];
        }
    } else {
        selectedModelIds.value = selectedModelIds.value.filter(id => id !== modelId);
    }
}

function selectAll() {
    selectedModelIds.value = [...fetchedModels.value];
}

function selectNone() {
    selectedModelIds.value = [];
}

function handleBack() {
    router.push({ name: 'VendorList' });
}
</script>

<style scoped>
.vendor-models {
    padding: 0;
}

.page-breadcrumb {
    margin-bottom: 16px;
}

.card-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
}

.model-count {
    color: var(--color-text-secondary, #888);
    font-size: 13px;
}

.select-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 12px;
}

.selected-count {
    margin-left: 8px;
    color: var(--color-text-secondary, #888);
    font-size: 13px;
}

.model-search {
    margin-bottom: 10px;
}

.model-checkbox-group {
    max-height: 400px;
    overflow-y: auto;
}

.model-checkbox-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--color-border-secondary, #f0f0f0);
    cursor: pointer;
}

.model-checkbox-item:hover {
    background: var(--color-fill-quaternary, #fafafa);
}

.model-checkbox-label {
    flex: 1;
    word-break: break-all;
    white-space: normal;
    font-size: 13px;
    line-height: 1.4;
    padding-top: 1px;
}

.empty-hint {
    color: var(--color-text-secondary, #888);
    text-align: center;
    padding: 24px 0;
}
</style>
