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
                    <a-select-option value="aliyun">Aliyun (通义千问)</a-select-option>
                    <a-select-option value="aliyun_coding">Aliyun Coding</a-select-option>
                    <a-select-option value="volcengine_coding">Volcengine Coding</a-select-option>
                    <a-select-option value="deepseek">DeepSeek</a-select-option>
                    <a-select-option value="openai">OpenAI</a-select-option>
                    <a-select-option value="anthropic">Anthropic</a-select-option>
                    <a-select-option value="google">Google</a-select-option>
                    <a-select-option value="other">Other</a-select-option>
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
                <div v-for="(item, index) in urlsForm" :key="index" class="url-item">
                    <a-row :gutter="8" align="middle">
                        <a-col :span="6">
                            <a-select v-model:value="item.type" style="width: 100%" placeholder="请选择 URL 类型">
                                <a-select-option
                                    v-for="type in URL_TYPES"
                                    :key="type.value"
                                    :value="type.value"
                                    :disabled="urlsForm.some((u, i) => u.type === type.value && i !== index)"
                                >
                                    {{ type.label }}
                                </a-select-option>
                            </a-select>
                        </a-col>
                        <a-col :span="16">
                            <a-input
                                v-model:value="item.url"
                                placeholder="请输入 URL"
                            />
                        </a-col>
                        <a-col :span="2">
                            <a-button type="text" danger @click="removeUrl(index)">
                                <DeleteOutlined />
                            </a-button>
                        </a-col>
                    </a-row>
                </div>
                <a-button
                    type="dashed"
                    block
                    @click="addUrl"
                    :disabled="urlsForm.length >= URL_TYPES.length"
                >
                    <PlusOutlined /> 添加 URL
                </a-button>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons-vue';
import { createVendor } from '@/api/vendor';
import type { CreateVendorRequest, Vendor, VendorUrls } from '@/types/vendor';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [vendor: Vendor];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();

const URL_TYPES = [
    { label: 'OpenAI', value: 'openai' },
    { label: 'Anthropic', value: 'anthropic' },
    { label: 'Google', value: 'google' },
];

const formState = reactive({
    type: 'openai' as const,
    name: '',
    token: '',
});

const urlsForm = reactive<{ type: string; url: string }[]>([{ type: URL_TYPES[0]!.value, url: '' }]);

const rules = {
    type: [{ required: true, message: '请选择供应商类型' }],
    name: [{ required: true, message: '请输入供应商名称' }],
    token: [{ required: true, message: '请输入 API Token' }],
};

function open() {
    visible.value = true;
}

function addUrl() {
    const usedTypes = urlsForm.map(u => u.type);
    const availableType = URL_TYPES.find(t => !usedTypes.includes(t.value));
    if (availableType) {
        urlsForm.push({ type: availableType.value, url: '' });
    }
}

function removeUrl(index: number) {
    urlsForm.splice(index, 1);
}

async function handleOk() {
    try {
        await formRef.value?.validate();

        const createData: CreateVendorRequest = {
            type: formState.type,
            name: formState.name,
            token: formState.token,
        };

        if (urlsForm.length > 0 && urlsForm.some(item => item.url)) {
            const urls: VendorUrls = {};
            urlsForm.forEach(item => {
                if (item.url) {
                    urls[item.type] = item.url;
                }
            });
            createData.urls = urls;
        }

        loading.value = true;
        const vendor = await createVendor(createData);
        notifySuccess('创建成功');
        emit('success', vendor);
        handleCancel();
    } catch (error) {
        notifyRequestError(error, '创建失败');
    } finally {
        loading.value = false;
    }
}

function handleCancel() {
    visible.value = false;
    formState.type = 'openai';
    formState.name = '';
    formState.token = '';
    urlsForm.splice(0, urlsForm.length, { type: 'openai', url: '' });
}

defineExpose({ open });
</script>

<style scoped>
.url-item {
    margin-bottom: 12px;
}
</style>
