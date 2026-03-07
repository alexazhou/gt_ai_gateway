<template>
    <a-modal
        v-model:open="visible"
        title="新建供应商"
        @ok="handleOk"
        @cancel="handleCancel"
        :confirm-loading="loading"
        width="600px"
    >
        <a-form
            :model="formState"
            :rules="rules"
            layout="vertical"
            ref="formRef"
        >
            <a-form-item label="类型" name="type">
                <a-select v-model:value="formState.type" placeholder="请选择供应商类型">
                    <a-select-option value="openai">OpenAI</a-select-option>
                    <a-select-option value="anthropic">Anthropic</a-select-option>
                    <a-select-option value="google">Google</a-select-option>
                </a-select>
            </a-form-item>
            <a-form-item label="名称" name="name">
                <a-input v-model:value="formState.name" placeholder="请输入供应商名称" />
            </a-form-item>
            <a-form-item label="Token" name="token">
                <a-input-password
                    v-model:value="formState.token"
                    placeholder="请输入 API Token"
                />
            </a-form-item>
            <a-form-item label="URLs 配置（可选）">
                <div v-for="key in Object.keys(urlsForm)" :key="key" class="url-item">
                    <a-form-item :label="key">
                        <a-input
                            v-model:value="urlsForm[key]"
                            placeholder="请输入 URL"
                        />
                    </a-form-item>
                </div>
                <a-button type="dashed" block @click="addUrl">
                    <PlusOutlined /> 添加 URL
                </a-button>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { message, type FormInstance } from 'ant-design-vue';
import { PlusOutlined } from '@ant-design/icons-vue';
import { createVendor } from '@/api/vendor';
import type { Vendor } from '@/types/vendor';

const emit = defineEmits<{
    success: [vendor: Vendor];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();

const formState = reactive({
    type: 'openai' as const,
    name: '',
    token: '',
});

const urlsForm = reactive<Record<string, string>>({});

const rules = {
    type: [{ required: true, message: '请选择供应商类型' }],
    name: [{ required: true, message: '请输入供应商名称' }],
    token: [{ required: true, message: '请输入 API Token' }],
};

function open() {
    visible.value = true;
}

function addUrl() {
    const key = `custom_${Date.now()}`;
    urlsForm[key] = '';
}

async function handleOk() {
    try {
        await formRef.value?.validate();

        const createData: any = {
            type: formState.type,
            name: formState.name,
            token: formState.token,
        };

        if (Object.keys(urlsForm).length > 0) {
            createData.urls = { ...urlsForm };
        }

        loading.value = true;
        const vendor = await createVendor(createData);
        message.success('创建成功');
        emit('success', vendor);
        handleCancel();
    } catch (error) {
        console.error('创建失败:', error);
    } finally {
        loading.value = false;
    }
}

function handleCancel() {
    visible.value = false;
    formState.type = 'openai';
    formState.name = '';
    formState.token = '';
    Object.keys(urlsForm).forEach(key => delete urlsForm[key]);
}

defineExpose({ open });
</script>

<style scoped>
.url-item {
    margin-bottom: 12px;
}
</style>
