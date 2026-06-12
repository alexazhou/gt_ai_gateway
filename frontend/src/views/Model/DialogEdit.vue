<template>
    <a-modal
        v-model:open="visible"
        title="编辑模型"
        @cancel="handleCancel"
        :confirm-loading="loading"
    >
        <template #footer>
            <div class="modal-footer">
                <a-button :disabled="!formState.vendor_id" @click="handleTest">测试连通性</a-button>
                <div>
                    <a-button @click="handleCancel">Cancel</a-button>
                    <a-button type="primary" :loading="loading" @click="handleOk">OK</a-button>
                </div>
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
            <a-form-item label="所属供应商" name="vendor_id">
                <a-select
                    v-model:value="formState.vendor_id"
                    placeholder="请选择供应商"
                    :loading="vendorsLoading"
                    @change="handleVendorChange"
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
            <a-form-item label="上游模型" name="vendor_model_id">
                <a-select
                    v-model:value="formState.vendor_model_id"
                    placeholder="自动（使用模型名称）"
                    :loading="vendorModelsLoading"
                    allow-clear
                    :disabled="!formState.vendor_id"
                >
                    <a-select-option
                        v-for="vm in vendorModels"
                        :key="vm.id"
                        :value="vm.id"
                    >
                        {{ vm.model_id }}
                    </a-select-option>
                </a-select>
            </a-form-item>
            <a-form-item label="状态" name="enable">
                <a-switch v-model:checked="formState.enable" />
            </a-form-item>
            <a-collapse v-model:activeKey="billingExpanded" ghost>
                <a-collapse-panel key="billing" header="价格设置">
                    <a-form-item style="margin-bottom: 12px;">
                        <div style="display: flex; align-items: center;">
                            <div style="flex: 0 0 110px; display: flex; align-items: center; gap: 4px; color: rgba(0, 0, 0, 0.88);">
                                输入价格
                                <a-tooltip title="输入token的计费价格 (元/千tokens)">
                                    <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                                </a-tooltip>
                            </div>
                            <div style="flex: 1;">
                                <a-input-number
                                    v-model:value="formState.prices.input"
                                    placeholder="请输入输入价格"
                                    :min="0"
                                    :precision="6"
                                    style="width: 100%"
                                />
                            </div>
                        </div>
                    </a-form-item>

                    <a-form-item style="margin-bottom: 12px;">
                        <div style="display: flex; align-items: center;">
                            <div style="flex: 0 0 110px; display: flex; align-items: center; gap: 4px; color: rgba(0, 0, 0, 0.88);">
                                输出价格
                                <a-tooltip title="输出token的计费价格 (元/千tokens)">
                                    <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                                </a-tooltip>
                            </div>
                            <div style="flex: 1;">
                                <a-input-number
                                    v-model:value="formState.prices.output"
                                    placeholder="请输入输出价格"
                                    :min="0"
                                    :precision="6"
                                    style="width: 100%"
                                />
                            </div>
                        </div>
                    </a-form-item>

                    <a-form-item style="margin-bottom: 0;">
                        <div style="display: flex; align-items: center;">
                            <div style="flex: 0 0 110px; display: flex; align-items: center; gap: 4px; color: rgba(0, 0, 0, 0.88);">
                                缓存读取价格
                                <a-tooltip title="缓存命中时读取token的计费价格 (元/千tokens)">
                                    <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                                </a-tooltip>
                            </div>
                            <div style="flex: 1;">
                                <a-input-number
                                    v-model:value="formState.prices.cache_read"
                                    placeholder="请输入缓存读取价格"
                                    :min="0"
                                    :precision="6"
                                    style="width: 100%"
                                />
                            </div>
                        </div>
                    </a-form-item>
                </a-collapse-panel>
            </a-collapse>
        </a-form>
    </a-modal>

    <DialogTest ref="testDialogRef" />
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { updateModel } from '@/api/model';
import { listVendors, listVendorModels } from '@/api/vendor';
import type { Model } from '@/types/model';
import type { Vendor as VendorType, VendorModel } from '@/types/vendor';
import { normalizeListResponse } from '@/utils/listResponse';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';
import DialogTest from '@/views/Vendor/DialogTest.vue';

const emit = defineEmits<{
    success: [model: Model];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();
const billingExpanded = ref<string[]>([]);
const testDialogRef = ref<InstanceType<typeof DialogTest>>();

const currentId = ref<number>(0);

const formState = reactive({
    name: '',
    vendor_id: undefined as number | undefined,
    vendor_model_id: undefined as number | undefined,
    enable: true,
    prices: {
        input: undefined as number | undefined,
        output: undefined as number | undefined,
        cache_read: undefined as number | undefined,
    },
});

const rules = {
    name: [{ required: true, message: '请输入模型名称' }],
    vendor_id: [{ required: true, message: '请选择供应商' }],
};

const vendors = ref<VendorType[]>([]);
const vendorsLoading = ref(false);
const vendorModels = ref<VendorModel[]>([]);
const vendorModelsLoading = ref(false);

const upstreamModelName = computed(() => {
    if (formState.vendor_model_id) {
        return vendorModels.value.find(vm => vm.id === formState.vendor_model_id)?.model_id ?? formState.name;
    }
    return formState.name;
});

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
    vendorModelsLoading.value = true;
    try {
        vendorModels.value = await listVendorModels(vendorId);
    } catch (error) {
        vendorModels.value = [];
    } finally {
        vendorModelsLoading.value = false;
    }
}

function handleVendorChange(vendorId: number) {
    formState.vendor_model_id = undefined;
    vendorModels.value = [];
    if (vendorId) {
        void loadVendorModels(vendorId);
    }
}

function handleTest() {
    const vendor = vendors.value.find(v => v.id === formState.vendor_id);
    if (!vendor) return;
    const vendorModelName = formState.vendor_model_id
        ? (vendorModels.value.find(vm => vm.id === formState.vendor_model_id)?.model_id ?? null)
        : null;
    testDialogRef.value?.open(vendor, upstreamModelName.value || undefined, {
        modelName: formState.name,
        vendorModelName,
    });
}

function open(model: Model) {
    formState.name = model.name;
    formState.vendor_id = model.vendor_id;
    formState.vendor_model_id = model.vendor_model_id ?? undefined;
    formState.enable = Boolean(model.enable);
    formState.prices = {
        input: model.prices?.input || undefined,
        output: model.prices?.output || undefined,
        cache_read: model.prices?.cache_read || undefined,
    };
    currentId.value = model.id;
    void loadVendors();
    if (model.vendor_id) {
        void loadVendorModels(model.vendor_id);
    }
    visible.value = true;
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        loading.value = true;
        const model = await updateModel(currentId.value, {
            ...formState,
            vendor_model_id: formState.vendor_model_id ?? null,
        });
        notifySuccess('更新成功');
        emit('success', model);
        handleCancel();
    } catch (error) {
        notifyRequestError(error, '更新失败');
    } finally {
        loading.value = false;
    }
}

function handleCancel() {
    visible.value = false;
    formState.name = '';
    formState.vendor_id = undefined;
    formState.vendor_model_id = undefined;
    formState.enable = true;
    formState.prices = {
        input: undefined,
        output: undefined,
        cache_read: undefined,
    };
    vendorModels.value = [];
}

defineExpose({ open });
</script>

<style scoped>
.modal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
}

.modal-footer > div {
    display: flex;
    gap: 8px;
}

</style>
