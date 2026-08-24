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
                    <template v-if="column.key === 'allowed_formats'">
                        <span v-if="!record.allowed_formats || record.allowed_formats.length === 0" class="format-auto">全部</span>
                        <a-space v-else :size="4" wrap>
                            <a-tag v-for="fmt in record.allowed_formats" :key="fmt" :color="formatTagColor(fmt)">
                                {{ fmt.toUpperCase() }}
                            </a-tag>
                        </a-space>
                    </template>
                    <template v-else-if="column.key === 'created_at'">
                        {{ formatDate(record.created_at) }}
                    </template>
                    <template v-if="column.key === 'action'">
                        <a-space>
                            <a-button type="link" size="small" style="padding: 0" @click="handleTest(record)">
                                测试
                            </a-button>
                            <a-button type="link" size="small" style="padding: 0" @click="handleEditFormats(record)">
                                编辑
                            </a-button>
                            <a-button type="link" danger size="small" style="padding: 0" @click="handleDelete(record)">
                                删除
                            </a-button>
                        </a-space>
                    </template>
                </template>
            </a-table>
        </a-card>

        <DialogTest ref="testDialogRef" />

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

        <!-- 编辑协议限制弹窗 -->
        <a-modal
            v-model:open="editFormatsVisible"
            title="编辑支持协议"
            :confirm-loading="editFormatsLoading"
            @ok="handleEditFormatsConfirm"
            @cancel="editFormatsVisible = false"
        >
            <a-form layout="horizontal" :label-col="{ span: 5 }" style="margin-top: 16px">
                <a-form-item label="支持协议">
                    <a-radio-group v-model:value="editFormatsMode">
                        <a-radio value="auto">全部</a-radio>
                        <a-radio value="manual">手动指定</a-radio>
                    </a-radio-group>
                </a-form-item>
                <a-form-item v-if="editFormatsMode === 'manual'" label="指定协议">
                    <a-checkbox-group v-model:value="editFormatsSelected" :options="formatOptions" />
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
import { getVendor, listVendorModels, fetchVendorModels, syncVendorModels, addVendorModel, updateVendorModel, deleteVendorModel } from '@/api/vendor';
import { formatDate } from '@/utils/format';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';
import type { Vendor, VendorModel } from '@/types/vendor';
import DialogTest from './DialogTest.vue';

const route = useRoute();
const router = useRouter();

const vendorId = Number(route.params.id);
const currentVendor = ref<Vendor | null>(null);
const vendorName = ref('');
const models = ref<VendorModel[]>([]);
const testDialogRef = ref<InstanceType<typeof DialogTest>>();
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

const FORMAT_OPTIONS = ['openai', 'anthropic', 'responses'] as const;
const formatOptions = FORMAT_OPTIONS.map(f => ({ label: f.toUpperCase(), value: f }));

function formatTagColor(fmt: string): string {
    if (fmt === 'anthropic') return 'orange';
    if (fmt === 'responses') return 'blue';
    return 'default';
}

const editFormatsVisible = ref(false);
const editFormatsLoading = ref(false);
const editFormatsRecord = ref<VendorModel | null>(null);
const editFormatsMode = ref<'auto' | 'manual'>('auto');
const editFormatsSelected = ref<string[]>([]);

const columns: TableColumnsType<VendorModel> = [
    { title: 'Model ID', key: 'model_id', dataIndex: 'model_id' },
    { title: '支持协议', key: 'allowed_formats', width: 180 },
    { title: '添加时间', key: 'created_at', dataIndex: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 140, fixed: 'right' as const },
];

onMounted(async () => {
    await Promise.all([loadVendorName(), loadModels()]);
});

async function loadVendorName() {
    try {
        const vendor = await getVendor(vendorId);
        currentVendor.value = vendor;
        vendorName.value = vendor.name;
    } catch {
        vendorName.value = `供应商 ${vendorId}`;
    }
}

function handleTest(record: VendorModel) {
    if (!currentVendor.value) return;
    testDialogRef.value?.openVendorTest(currentVendor.value, record.model_id);
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

function handleEditFormats(record: VendorModel) {
    editFormatsRecord.value = record;
    if (record.allowed_formats && record.allowed_formats.length > 0) {
        editFormatsMode.value = 'manual';
        editFormatsSelected.value = [...record.allowed_formats];
    } else {
        editFormatsMode.value = 'auto';
        editFormatsSelected.value = [];
    }
    editFormatsVisible.value = true;
}

async function handleEditFormatsConfirm() {
    if (!editFormatsRecord.value) return;
    editFormatsLoading.value = true;
    try {
        const newFormats = editFormatsMode.value === 'manual' && editFormatsSelected.value.length > 0
            ? editFormatsSelected.value : null;
        const updated = await updateVendorModel(vendorId, editFormatsRecord.value.id, newFormats);
        const idx = models.value.findIndex(m => m.id === updated.id);
        if (idx !== -1) models.value[idx] = updated;
        notifySuccess('已更新');
        editFormatsVisible.value = false;
    } catch (error) {
        notifyRequestError(error, '更新失败');
    } finally {
        editFormatsLoading.value = false;
    }
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
    color: var(--text-secondary, #888);
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
    color: var(--text-secondary, #888);
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
    border-bottom: 1px solid var(--border-color, #f0f0f0);
    cursor: pointer;
}

.model-checkbox-item:hover {
    background: var(--bg-info-item, #fafafa);
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
    color: var(--text-secondary, #888);
    text-align: center;
    padding: 24px 0;
}

.format-auto {
    color: var(--text-secondary, #888);
    font-size: 13px;
}
</style>
