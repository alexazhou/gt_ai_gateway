<template>
    <div class="upstream-editor">
        <div class="upstream-list">
            <div class="upstream-table">
                <div
                    class="upstream-table-header"
                    :class="{ 'single-mode-grid': routingMode === 'single' }"
                >
                    <span>供应商</span>
                    <span>上游模型</span>
                    <span v-if="routingMode !== 'single'" class="centered-column">启用</span>
                    <span class="centered-column">操作</span>
                </div>
                <div
                    v-for="(upstream, index) in upstreams"
                    :key="index"
                    class="upstream-row"
                    :class="{ 'single-mode-grid': routingMode === 'single' }"
                >
                    <div class="upstream-field">
                        <a-select
                            :value="upstream.vendor_id"
                            placeholder="请选择供应商"
                            :loading="vendorsLoading"
                            :disabled="mode === 'view'"
                            @change="handleVendorChange(index, $event)"
                        >
                            <a-select-option
                                v-for="vendor in vendors"
                                :key="vendor.id"
                                :value="vendor.id"
                            >
                                {{ vendor.name }}
                            </a-select-option>
                        </a-select>
                    </div>
                    <div class="upstream-field">
                        <a-select
                            :value="upstream.vendor_model_id"
                            placeholder="自动（使用模型名称）"
                            :loading="isVendorModelsLoading(upstream.vendor_id)"
                            allow-clear
                            :disabled="mode === 'view' || !upstream.vendor_id"
                            @change="updateVendorModel(index, $event)"
                        >
                            <a-select-option
                                v-for="vendorModel in getVendorModels(upstream.vendor_id)"
                                :key="vendorModel.id"
                                :value="vendorModel.id"
                            >
                                {{ vendorModel.model_id }}
                            </a-select-option>
                        </a-select>
                    </div>
                    <div v-if="routingMode !== 'single'" class="upstream-enabled">
                        <a-switch
                            :checked="upstream.enabled"
                            size="small"
                            :disabled="mode === 'view'"
                            @change="updateEnabled(index, $event)"
                        />
                    </div>
                    <div class="upstream-actions">
                        <a-tooltip v-if="routingMode === 'failover'" title="上移">
                            <a-button
                                type="text"
                                size="small"
                                :disabled="mode === 'view' || index === 0"
                                aria-label="上移"
                                @click="moveUpstream(index, -1)"
                            >
                                <ArrowUpOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip v-if="routingMode === 'failover'" title="下移">
                            <a-button
                                type="text"
                                size="small"
                                :disabled="mode === 'view' || index === upstreams.length - 1"
                                aria-label="下移"
                                @click="moveUpstream(index, 1)"
                            >
                                <ArrowDownOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="测试">
                            <a-button
                                type="text"
                                size="small"
                                :disabled="mode === 'view' || !upstream.vendor_id"
                                aria-label="测试"
                                @click="handleTest(upstream)"
                            >
                                <ExperimentOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip
                            v-if="routingMode !== 'single' && upstreams.length > 1"
                            title="删除"
                        >
                            <a-button
                                type="text"
                                danger
                                size="small"
                                :disabled="mode === 'view'"
                                aria-label="删除"
                                @click="removeUpstream(index)"
                            >
                                <DeleteOutlined />
                            </a-button>
                        </a-tooltip>
                    </div>
                </div>
            </div>
            <a-button
                v-if="routingMode !== 'single'"
                block
                type="dashed"
                :disabled="mode === 'view'"
                @click="addUpstream"
            >
                <PlusOutlined />
                添加上游
            </a-button>
        </div>
    </div>

    <DialogTest v-if="mode === 'edit'" ref="testDialogRef" />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
    ArrowDownOutlined,
    ArrowUpOutlined,
    DeleteOutlined,
    ExperimentOutlined,
    PlusOutlined,
} from '@ant-design/icons-vue';
import { listVendors, listVendorModels } from '@/api/vendor';
import type { ModelRoutingMode, ModelUpstreamFormValue } from '@/types/model';
import type { Vendor, VendorModel } from '@/types/vendor';
import { normalizeListResponse } from '@/utils/listResponse';
import { notifyRequestError } from '@/utils/requestFeedback';
import DialogTest from '@/views/Vendor/DialogTest.vue';

const props = defineProps<{
    mode: 'edit' | 'view';
    routingMode: ModelRoutingMode;
    modelName: string;
    upstreams: ModelUpstreamFormValue[];
}>();

const emit = defineEmits<{
    'update:upstreams': [upstreams: ModelUpstreamFormValue[]];
}>();

const vendors = ref<Vendor[]>([]);
const vendorsLoading = ref(false);
const vendorModelsByVendor = ref<Map<number, VendorModel[]>>(new Map());
const loadingVendorIds = ref<Set<number>>(new Set());
const testDialogRef = ref<InstanceType<typeof DialogTest>>();

onMounted(() => {
    void loadVendors();
});

watch(
    () => props.upstreams.map(upstream => upstream.vendor_id),
    vendorIds => {
        for (const vendorId of new Set(vendorIds)) {
            if (vendorId) {
                void loadVendorModels(vendorId);
            }
        }
    },
    { immediate: true },
);

async function loadVendors() {
    vendorsLoading.value = true;
    try {
        vendors.value = normalizeListResponse(await listVendors({ page: 1, pageSize: 1000 })).list;
    } catch (error) {
        notifyRequestError(error, '加载供应商列表失败');
    } finally {
        vendorsLoading.value = false;
    }
}


async function loadVendorModels(vendorId: number) {
    if (vendorModelsByVendor.value.has(vendorId) || loadingVendorIds.value.has(vendorId)) {
        return;
    }

    loadingVendorIds.value = new Set([...loadingVendorIds.value, vendorId]);
    try {
        const models = await listVendorModels(vendorId);
        const next = new Map(vendorModelsByVendor.value);
        next.set(vendorId, models);
        vendorModelsByVendor.value = next;
    } catch {
        const next = new Map(vendorModelsByVendor.value);
        next.set(vendorId, []);
        vendorModelsByVendor.value = next;
    } finally {
        const next = new Set(loadingVendorIds.value);
        next.delete(vendorId);
        loadingVendorIds.value = next;
    }
}


function getVendorModels(vendorId?: number): VendorModel[] {
    return vendorId ? vendorModelsByVendor.value.get(vendorId) ?? [] : [];
}


function isVendorModelsLoading(vendorId?: number): boolean {
    return vendorId ? loadingVendorIds.value.has(vendorId) : false;
}


function updateUpstream(index: number, value: Partial<ModelUpstreamFormValue>) {
    emit('update:upstreams', props.upstreams.map((upstream, currentIndex) => (
        currentIndex === index ? { ...upstream, ...value } : upstream
    )));
}


function handleVendorChange(index: number, vendorId: number) {
    updateUpstream(index, {
        vendor_id: vendorId,
        vendor_model_id: undefined,
    });
    void loadVendorModels(vendorId);
}


function updateVendorModel(index: number, vendorModelId?: number) {
    updateUpstream(index, { vendor_model_id: vendorModelId });
}


function updateEnabled(index: number, enabled: boolean) {
    updateUpstream(index, { enabled });
}


function addUpstream() {
    emit('update:upstreams', [
        ...props.upstreams,
        { enabled: true },
    ]);
}


function removeUpstream(index: number) {
    if (props.upstreams.length > 1) {
        emit('update:upstreams', props.upstreams.filter((_, currentIndex) => currentIndex !== index));
    }
}


function moveUpstream(index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= props.upstreams.length) {
        return;
    }

    const next = [...props.upstreams];
    const [upstream] = next.splice(index, 1);
    if (upstream) {
        next.splice(targetIndex, 0, upstream);
        emit('update:upstreams', next);
    }
}


function handleTest(upstream: ModelUpstreamFormValue) {
    const vendor = vendors.value.find(item => item.id === upstream.vendor_id);
    if (!vendor) {
        return;
    }

    const vendorModelName = upstream.vendor_model_id
        ? (getVendorModels(upstream.vendor_id).find(model => model.id === upstream.vendor_model_id)?.model_id ?? null)
        : null;
    testDialogRef.value?.open(vendor, (vendorModelName ?? props.modelName) || undefined, {
        modelName: props.modelName,
        vendorModelName,
    });
}


</script>

<style scoped>
.upstream-editor {
    width: 100%;
}

.upstream-list {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 10px;
}

.upstream-table {
    overflow: hidden;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-card);
}

.upstream-table-header,
.upstream-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr) 44px 128px;
    align-items: center;
    gap: 10px;
}

.upstream-table-header {
    padding: 8px 12px 4px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-info-item);
    color: var(--text-secondary);
    font-size: 12px;
}

.upstream-row {
    padding: 6px 12px 10px;
    border-bottom: 1px solid var(--border-color);
}

.upstream-row:last-child {
    border-bottom: 0;
}

.single-mode-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr) 40px;
}

.centered-column {
    text-align: center;
}

.upstream-actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    justify-content: center;
    gap: 0;
}

.upstream-actions :deep(.ant-btn) {
    width: 30px;
    padding-inline: 0;
}

.upstream-field {
    min-width: 0;
}

.upstream-field :deep(.ant-select) {
    width: 100%;
}

.upstream-enabled {
    display: flex;
    justify-content: center;
    align-items: center;
}
</style>
