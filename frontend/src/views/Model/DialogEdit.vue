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
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { message, type FormInstance } from 'ant-design-vue';
import { updateModel } from '@/api/model';
import { listVendors } from '@/api/vendor';
import type { Model } from '@/types/model';
import type { Vendor as VendorType } from '@/types/vendor';

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
        vendors.value = await listVendors();
    } catch (error) {
        console.error('加载供应商列表失败:', error);
    } finally {
        vendorsLoading.value = false;
    }
}

function open(model: Model) {
    formState.name = model.name;
    formState.vendor_id = model.vendor_id;
    formState.enable = model.enable;
    currentId.value = model.id;
    loadVendors();
    visible.value = true;
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        loading.value = true;
        const model = await updateModel(currentId.value, formState);
        message.success('更新成功');
        emit('success', model);
        handleCancel();
    } catch (error) {
        console.error('更新失败:', error);
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
