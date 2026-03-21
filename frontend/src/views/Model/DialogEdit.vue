<template>
    <a-modal
        v-model:open="visible"
        title="编辑模型"
        @ok="handleOk"
        @cancel="handleCancel"
        :confirm-loading="loading"
    >
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
            <a-form-item label="状态" name="enable">
                <a-switch v-model:checked="formState.enable" />
            </a-form-item>
            <a-divider>计费设置</a-divider>
            <a-form-item>
                <template #label>
                    <span style="display: flex; align-items: center; gap: 4px;">
                        输入价格
                        <a-tooltip title="元/千tokens">
                            <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                        </a-tooltip>
                    </span>
                </template>
                <a-input-number
                    v-model:value="formState.input_price"
                    placeholder="请输入输入价格"
                    :min="0"
                    :precision="6"
                    style="width: 100%"
                />
                <template #extra>
                    <span style="color: #999; font-size: 12px">输入token的计费价格</span>
                </template>
            </a-form-item>
            <a-form-item>
                <template #label>
                    <span style="display: flex; align-items: center; gap: 4px;">
                        输出价格
                        <a-tooltip title="元/千tokens">
                            <InfoCircleOutlined style="font-size: 12px; color: #999;" />
                        </a-tooltip>
                    </span>
                </template>
                <a-input-number
                    v-model:value="formState.output_price"
                    placeholder="请输入输出价格"
                    :min="0"
                    :precision="6"
                    style="width: 100%"
                />
                <template #extra>
                    <span style="color: #999; font-size: 12px">输出token的计费价格</span>
                </template>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { updateModel } from '@/api/model';
import { listVendors } from '@/api/vendor';
import type { Model } from '@/types/model';
import type { Vendor as VendorType } from '@/types/vendor';
import { normalizeListResponse } from '@/utils/listResponse';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [model: Model];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();

const currentId = ref<number>(0);

const formState = reactive({
    name: '',
    vendor_id: undefined as number | undefined,
    enable: true,
    input_price: 0,
    output_price: 0,
});

const rules = {
    name: [{ required: true, message: '请输入模型名称' }],
    vendor_id: [{ required: true, message: '请选择供应商' }],
};

const vendors = ref<VendorType[]>([]);
const vendorsLoading = ref(false);

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

function open(model: Model) {
    formState.name = model.name;
    formState.vendor_id = model.vendor_id;
    formState.enable = Boolean(model.enable); // Convert number to boolean
    formState.input_price = model.input_price;
    formState.output_price = model.output_price;
    currentId.value = model.id;
    void loadVendors();
    visible.value = true;
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        loading.value = true;
        const model = await updateModel(currentId.value, formState);
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
    formState.enable = true;
    formState.input_price = 0;
    formState.output_price = 0;
}

defineExpose({ open });
</script>
