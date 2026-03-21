<template>
    <a-modal
        v-model:open="visible"
        title="新建模型"
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
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { createModel } from '@/api/model';
import { listVendors } from '@/api/vendor';
import type { Model } from '@/types/model';
import type { Vendor as VendorType } from '@/types/vendor';
import { normalizeListResponse } from '@/utils/listResponse';
import { notifyError, notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [model: Model];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();

const formState = reactive({
    name: '',
    vendor_id: undefined as number | undefined,
    enable: true,
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

function open() {
    void loadVendors();
    visible.value = true;
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        loading.value = true;
        // 确保 vendor_id 不为空（表单验证应该已经保证）
        if (formState.vendor_id === undefined) {
            notifyError('请选择供应商');
            return;
        }
        const model = await createModel({
            name: formState.name,
            vendor_id: formState.vendor_id,
            enable: formState.enable,
        });
        notifySuccess('创建成功');
        emit('success', model);
        handleCancel();
    } catch (error) {
        notifyRequestError(error, '创建失败');
    } finally {
        loading.value = false;
    }
}

function handleCancel() {
    visible.value = false;
    formState.name = '';
    formState.vendor_id = undefined;
    formState.enable = true;
}

defineExpose({ open });
</script>
