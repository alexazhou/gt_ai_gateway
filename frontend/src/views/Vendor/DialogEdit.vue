<template>
    <a-modal
        v-model:open="visible"
        title="编辑供应商"
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
                    <a-select-option value="mimo">Mimo</a-select-option>
                    <a-select-option value="mimo_token_plan">Mimo Token Plan</a-select-option>
                    <a-select-option value="opencode_go">OpenCode Go</a-select-option>
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
            <a-form-item label="URLs 配置">
                <!-- 查看模式：合并展示 preset + 用户自定义 -->
                <template v-if="urlsMode === 'view'">
                    <div class="urls-view">
                        <div v-for="item in mergedUrls" :key="item.key" class="url-view-item">
                            <span class="url-key">{{ item.key }}:</span>
                            <span class="url-value">{{ item.url }}</span>
                            <a-tag v-if="item.isCustom" color="blue" class="custom-tag">自定义</a-tag>
                        </div>
                    </div>
                    <a-button type="link" size="small" class="toggle-btn" @click="urlsMode = 'edit'">
                        <EditOutlined /> 编辑
                    </a-button>
                </template>
                <!-- 编辑模式：仅用户自定义条目 -->
                <template v-else>
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
                                <a-input v-model:value="item.url" placeholder="请输入 URL" />
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
                    <a-button v-if="currentTypePreset" type="link" size="small" class="toggle-btn" @click="urlsMode = 'view'">
                        返回查看
                    </a-button>
                </template>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons-vue';
import { updateVendor } from '@/api/vendor';
import type { UpdateVendorRequest, Vendor, VendorType, VendorUrls } from '@/types/vendor';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';
import { useVendorPresets } from '@/composables/useVendorPresets';

const emit = defineEmits<{
    success: [vendor: Vendor];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();

const URL_TYPES = [
    { label: 'OpenAI', value: 'openai' },
    { label: 'Anthropic', value: 'anthropic' },
];

const { presetUrls, load: loadPresets } = useVendorPresets();
const PRESET_URLS = presetUrls;

const currentId = ref<number>(0);

const formState = reactive({
    type: 'openai' as VendorType,
    name: '',
    token: '',
});

const urlsMode = ref<'view' | 'edit'>('view');

// 用户自定义条目（从 vendor.urls 初始化）
const urlsForm = reactive<{ type: string; url: string }[]>([]);

const currentTypePreset = computed(() => PRESET_URLS.value[formState.type] ?? null);

// 查看模式：preset 为底，用户自定义覆盖，有自定义的标记
const mergedUrls = computed(() => {
    const preset = PRESET_URLS.value[formState.type] ?? {};
    const customMap: Record<string, string> = {};
    urlsForm.forEach(item => {
        if (item.url) customMap[item.type] = item.url;
    });
    const keys = new Set([...Object.keys(preset), ...Object.keys(customMap)]);
    return Array.from(keys).map(key => ({
        key,
        url: customMap[key] ?? preset[key] ?? '',
        isCustom: !!customMap[key],
    }));
});

// 切换类型时只更新模式，保留用户已填写的自定义 URLs
watch(() => formState.type, (newType) => {
    urlsMode.value = PRESET_URLS.value[newType] ? 'view' : 'edit';
});

const rules = {
    type: [{ required: true, message: '请选择供应商类型' }],
    name: [{ required: true, message: '请输入供应商名称' }],
    token: [{ required: true, message: '请输入 API Token' }],
};

function open(vendor: Vendor) {
    currentId.value = vendor.id;
    formState.type = vendor.type;
    formState.name = vendor.name;
    formState.token = vendor.token;

    // 加载已保存的自定义 URLs
    urlsForm.splice(0, urlsForm.length);
    Object.entries(vendor.urls).forEach(([key, url]) => {
        if (url !== undefined) urlsForm.push({ type: key, url });
    });

    void loadPresets();
    urlsMode.value = PRESET_URLS.value[vendor.type] ? 'view' : 'edit';
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

        const urls: VendorUrls = {};
        urlsForm.forEach(item => {
            if (item.url) urls[item.type] = item.url;
        });

        const updateData: UpdateVendorRequest = {
            type: formState.type,
            name: formState.name,
            token: formState.token,
            urls,
        };

        loading.value = true;
        const vendor = await updateVendor(currentId.value, updateData);
        notifySuccess('更新成功');
        emit('success', vendor);
        handleCancel();
    } catch (error) {
        notifyRequestError(error, '更新失败');
    } finally {
        loading.value = false;
    }
}

function handleCancel() {
    visible.value = false;
}

defineExpose({ open });
</script>

<style scoped>
.url-item {
    margin-bottom: 12px;
}

.urls-view {
    border: 1px solid var(--color-border, #d9d9d9);
    border-radius: 6px;
    padding: 8px 12px;
    background: var(--color-bg-container-disabled, #f5f5f5);
}

.url-view-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
    font-size: 13px;
}

.url-key {
    color: var(--color-text-secondary, #888);
    text-transform: uppercase;
    font-size: 11px;
    min-width: 72px;
    flex-shrink: 0;
}

.url-value {
    color: var(--color-text, #333);
    word-break: break-all;
    flex: 1;
}

.custom-tag {
    flex-shrink: 0;
}

.toggle-btn {
    padding: 0;
    margin-top: 6px;
    height: auto;
}
</style>
