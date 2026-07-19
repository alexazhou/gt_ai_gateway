<template>
    <a-modal
        v-model:open="visible"
        :title="isEdit ? '编辑模型' : '新建模型'"
        @cancel="handleCancel"
        :confirm-loading="loading"
        :width="760"
    >
        <template #footer>
            <div class="modal-footer">
                <a-button @click="handleCancel">Cancel</a-button>
                <a-button type="primary" :loading="loading" @click="handleOk">OK</a-button>
            </div>
        </template>
        <a-form
            :model="formState"
            :rules="rules"
            layout="vertical"
            ref="formRef"
        >
            <a-form-item label="模型名称" name="name">
                <a-input v-model:value="formState.name" placeholder="请输入模型名称" />
            </a-form-item>
            <a-form-item label="路由模式" name="routing_mode">
                <a-radio-group
                    v-model:value="formState.routing_mode"
                    button-style="solid"
                    @change="handleRoutingModeChange"
                >
                    <a-radio-button value="single">单上游</a-radio-button>
                    <a-radio-button value="load_balance">负载均衡</a-radio-button>
                    <a-radio-button value="failover">故障转移</a-radio-button>
                </a-radio-group>
                <div class="routing-hint">{{ routingModeDescription }}</div>
            </a-form-item>
            <a-form-item label="上游配置" required>
                <div class="upstream-list">
                    <div
                        v-for="(upstream, index) in formState.upstreams"
                        :key="upstream.key"
                        class="upstream-card"
                    >
                        <div class="upstream-header">
                            <span>上游 {{ index + 1 }}</span>
                            <a-space size="small">
                                <a-button
                                    v-if="formState.routing_mode === 'failover'"
                                    type="link"
                                    size="small"
                                    :disabled="index === 0"
                                    @click="moveUpstream(index, -1)"
                                >
                                    上移
                                </a-button>
                                <a-button
                                    v-if="formState.routing_mode === 'failover'"
                                    type="link"
                                    size="small"
                                    :disabled="index === formState.upstreams.length - 1"
                                    @click="moveUpstream(index, 1)"
                                >
                                    下移
                                </a-button>
                                <a-button
                                    type="link"
                                    size="small"
                                    :disabled="!upstream.vendor_id"
                                    @click="handleTest(upstream)"
                                >
                                    测试
                                </a-button>
                                <a-button
                                    v-if="formState.routing_mode !== 'single'"
                                    type="link"
                                    danger
                                    size="small"
                                    :disabled="formState.upstreams.length === 1"
                                    @click="removeUpstream(index)"
                                >
                                    删除
                                </a-button>
                            </a-space>
                        </div>
                        <div class="upstream-fields">
                            <div class="upstream-field">
                                <label>供应商</label>
                                <a-select
                                    v-model:value="upstream.vendor_id"
                                    placeholder="请选择供应商"
                                    :loading="vendorsLoading"
                                    @change="handleVendorChange(upstream)"
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
                            <div class="upstream-field upstream-model-field">
                                <label>上游模型</label>
                                <a-select
                                    v-model:value="upstream.vendor_model_id"
                                    placeholder="自动（使用模型名称）"
                                    :loading="isVendorModelsLoading(upstream.vendor_id)"
                                    allow-clear
                                    :disabled="!upstream.vendor_id"
                                >
                                    <a-select-option
                                        v-for="vm in getVendorModels(upstream.vendor_id)"
                                        :key="vm.id"
                                        :value="vm.id"
                                    >
                                        {{ vm.model_id }}
                                    </a-select-option>
                                </a-select>
                            </div>
                            <div class="upstream-enabled">
                                <label>启用</label>
                                <a-switch
                                    v-model:checked="upstream.enabled"
                                    :disabled="formState.routing_mode === 'single'"
                                />
                            </div>
                        </div>
                    </div>
                    <a-button
                        v-if="formState.routing_mode !== 'single'"
                        block
                        type="dashed"
                        @click="addUpstream"
                    >
                        添加上游
                    </a-button>
                </div>
            </a-form-item>
            <a-form-item label="状态" name="enable">
                <a-switch v-model:checked="formState.enable" />
            </a-form-item>
            <SettingsCollapse v-if="moduleBillingEnabled" v-model:activeKey="billingExpanded" panel-key="billing" header="价格设置">
                <div class="settings-row">
                    <label class="settings-label">
                        输入价格
                        <a-tooltip title="输入token的计费价格 (元/千tokens)">
                            <InfoCircleOutlined style="font-size: 12px; color: #999; margin-left: 4px;" />
                        </a-tooltip>
                    </label>
                    <div style="flex: 1">
                        <a-input-number
                            v-model:value="formState.prices.input"
                            placeholder="请输入输入价格"
                            :min="0"
                            :precision="6"
                            style="width: 100%"
                        />
                    </div>
                </div>
                <div class="settings-row">
                    <label class="settings-label">
                        输出价格
                        <a-tooltip title="输出token的计费价格 (元/千tokens)">
                            <InfoCircleOutlined style="font-size: 12px; color: #999; margin-left: 4px;" />
                        </a-tooltip>
                    </label>
                    <div style="flex: 1">
                        <a-input-number
                            v-model:value="formState.prices.output"
                            placeholder="请输入输出价格"
                            :min="0"
                            :precision="6"
                            style="width: 100%"
                        />
                    </div>
                </div>
                <div class="settings-row">
                    <label class="settings-label">
                        缓存读取价格
                        <a-tooltip title="缓存命中时读取token的计费价格 (元/千tokens)">
                            <InfoCircleOutlined style="font-size: 12px; color: #999; margin-left: 4px;" />
                        </a-tooltip>
                    </label>
                    <div style="flex: 1">
                        <a-input-number
                            v-model:value="formState.prices.cache_read"
                            placeholder="请输入缓存读取价格"
                            :min="0"
                            :precision="6"
                            style="width: 100%"
                        />
                    </div>
                </div>
            </SettingsCollapse>
        </a-form>
    </a-modal>

    <DialogTest ref="testDialogRef" />
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { createModel, updateModel } from '@/api/model';
import { listVendors, listVendorModels } from '@/api/vendor';
import { getConfig } from '@/api/config';
import SettingsCollapse from '@/components/common/SettingsCollapse.vue';
import type { CreateModelRequest, Model, ModelRoutingMode, ModelRoutingConfig } from '@/types/model';
import type { Vendor as VendorType, VendorModel } from '@/types/vendor';
import { normalizeListResponse } from '@/utils/listResponse';
import { notifyError, notifyRequestError, notifySuccess } from '@/utils/requestFeedback';
import DialogTest from '@/views/Vendor/DialogTest.vue';

const emit = defineEmits<{
    success: [model: Model];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();
const billingExpanded = ref<string[]>([]);
const testDialogRef = ref<InstanceType<typeof DialogTest>>();

const isEdit = ref(false);
const currentId = ref<number>(0);
let upstreamKey = 0;

interface UpstreamFormState {
    key: number;
    vendor_id?: number;
    vendor_model_id?: number;
    enabled: boolean;
}

function createUpstream(data?: Partial<UpstreamFormState>): UpstreamFormState {
    return {
        key: upstreamKey++,
        vendor_id: data?.vendor_id,
        vendor_model_id: data?.vendor_model_id,
        enabled: data?.enabled ?? true,
    };
}

const formState = reactive({
    name: '',
    routing_mode: 'single' as ModelRoutingMode,
    upstreams: [createUpstream()] as UpstreamFormState[],
    enable: true,
    prices: {
        input: undefined as number | undefined,
        output: undefined as number | undefined,
        cache_read: undefined as number | undefined,
    },
});

const rules = {
    name: [{ required: true, message: '请输入模型名称' }],
};

const vendors = ref<VendorType[]>([]);
const vendorsLoading = ref(false);
const moduleBillingEnabled = ref(false);
const vendorModelsByVendor = ref<Map<number, VendorModel[]>>(new Map());
const loadingVendorIds = ref<Set<number>>(new Set());

const routingModeDescription = computed(() => ({
    single: '使用唯一启用的上游。',
    load_balance: '从所有可用上游中等概率选择。',
    failover: '按列表顺序选择，第一个不可用时自动切换到下一个。',
})[formState.routing_mode]);

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

function handleVendorChange(upstream: UpstreamFormState) {
    upstream.vendor_model_id = undefined;
    if (upstream.vendor_id) {
        void loadVendorModels(upstream.vendor_id);
    }
}

function addUpstream() {
    formState.upstreams.push(createUpstream());
}

function handleRoutingModeChange() {
    if (formState.routing_mode !== 'single') {
        return;
    }

    const upstream = formState.upstreams.find(item => item.enabled)
        ?? formState.upstreams[0]
        ?? createUpstream();
    upstream.enabled = true;
    formState.upstreams = [upstream];
}

function removeUpstream(index: number) {
    if (formState.upstreams.length > 1) {
        formState.upstreams.splice(index, 1);
    }
}

function moveUpstream(index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= formState.upstreams.length) {
        return;
    }

    const [upstream] = formState.upstreams.splice(index, 1);
    if (upstream) {
        formState.upstreams.splice(targetIndex, 0, upstream);
    }
}

function handleTest(upstream: UpstreamFormState) {
    const vendor = vendors.value.find(v => v.id === upstream.vendor_id);
    if (!vendor) return;
    const vendorModelName = upstream.vendor_model_id
        ? (getVendorModels(upstream.vendor_id).find(vm => vm.id === upstream.vendor_model_id)?.model_id ?? null)
        : null;
    testDialogRef.value?.open(vendor, (vendorModelName ?? formState.name) || undefined, {
        modelName: formState.name,
        vendorModelName,
    });
}

function openCreate() {
    resetForm();
    isEdit.value = false;
    currentId.value = 0;
    billingExpanded.value = [];
    void loadVendors();
    getConfig().then(config => {
        moduleBillingEnabled.value = config.module_billing_enabled === 'true';
    });
    visible.value = true;
}

function openEdit(model: Model) {
    resetForm();
    isEdit.value = true;
    currentId.value = model.id;
    billingExpanded.value = [];
    formState.name = model.name;
    formState.routing_mode = model.routing_mode;
    const upstreams = model.routing_config.upstreams;
    formState.upstreams = upstreams.map(upstream => createUpstream({
        vendor_id: upstream.vendor_id,
        vendor_model_id: upstream.vendor_model_id,
        enabled: upstream.enabled,
    }));
    formState.enable = Boolean(model.enable);
    formState.prices = {
        input: model.prices?.input || undefined,
        output: model.prices?.output || undefined,
        cache_read: model.prices?.cache_read || undefined,
    };
    void loadVendors();
    for (const vendorId of new Set(upstreams.map(upstream => upstream.vendor_id))) {
        void loadVendorModels(vendorId);
    }
    getConfig().then(config => {
        moduleBillingEnabled.value = config.module_billing_enabled === 'true';
    });
    visible.value = true;
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        if (formState.upstreams.some(upstream => !upstream.vendor_id)) {
            notifyError('请为每个上游选择供应商');
            return;
        }

        const enabledCount = formState.upstreams.filter(upstream => upstream.enabled).length;
        if (enabledCount === 0) {
            notifyError('至少需要启用一个上游');
            return;
        }
        if (formState.routing_mode === 'single' && enabledCount !== 1) {
            notifyError('单上游模式只能启用一个上游');
            return;
        }

        loading.value = true;
        const routingConfig: ModelRoutingConfig = {
            upstreams: formState.upstreams.map(upstream => ({
                vendor_id: upstream.vendor_id!,
                ...(upstream.vendor_model_id ? { vendor_model_id: upstream.vendor_model_id } : {}),
                enabled: upstream.enabled,
            })),
        };
        const requestData: CreateModelRequest = {
            name: formState.name,
            enable: formState.enable,
            routing_mode: formState.routing_mode,
            routing_config: routingConfig,
            prices: {
                input: formState.prices.input ?? undefined,
                output: formState.prices.output ?? undefined,
                cache_read: formState.prices.cache_read ?? undefined,
            },
        };

        if (isEdit.value) {
            const model = await updateModel(currentId.value, requestData);
            notifySuccess('更新成功');
            emit('success', model);
        } else {
            const model = await createModel(requestData);
            notifySuccess('创建成功');
            emit('success', model);
        }
        handleCancel();
    } catch (error) {
        notifyRequestError(error, isEdit.value ? '更新失败' : '创建失败');
    } finally {
        loading.value = false;
    }
}

function resetForm() {
    formState.name = '';
    formState.routing_mode = 'single';
    formState.upstreams = [createUpstream()];
    vendorModelsByVendor.value = new Map();
    loadingVendorIds.value = new Set();
    formState.enable = true;
    formState.prices = {
        input: undefined,
        output: undefined,
        cache_read: undefined,
    };
}

function handleCancel() {
    visible.value = false;
    isEdit.value = false;
    currentId.value = 0;
    resetForm();
}

defineExpose({ openCreate, openEdit });
</script>

<style scoped>
.modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
}

.routing-hint {
    margin-top: 8px;
    color: var(--text-secondary);
    font-size: 12px;
}

.upstream-list {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 8px;
}

.upstream-card {
    padding: 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-page);
}

.upstream-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    font-weight: 500;
}

.upstream-fields {
    display: flex;
    align-items: flex-end;
    gap: 12px;
}

.upstream-field {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
}

.upstream-model-field {
    flex: 1.2;
}

.upstream-enabled {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding-bottom: 5px;
}

.upstream-field label,
.upstream-enabled label {
    color: var(--text-secondary);
    font-size: 12px;
}
</style>
