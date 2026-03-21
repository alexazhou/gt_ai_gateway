<template>
    <a-modal
        v-model:open="visible"
        title="供应商连通性测试"
        :footer="null"
        width="600px"
    >
        <div class="test-dialog">
            <div class="test-config">
                <a-form layout="vertical">
                    <a-form-item label="测试格式">
                        <a-radio-group v-model:value="format">
                            <a-radio-button value="openai">OpenAI</a-radio-button>
                            <a-radio-button value="anthropic">Anthropic</a-radio-button>
                        </a-radio-group>
                    </a-form-item>

                    <a-form-item label="测试模型">
                        <a-select
                            v-model:value="testModel"
                            placeholder="请选择或直接输入模型名称"
                            show-search
                            allow-clear
                            :loading="modelsLoading"
                            :options="selectOptions"
                            @search="handleSearch"
                            :filter-option="false"
                            option-label-prop="value"
                        >
                            <template #option="{ value, isCustom }">
                                <span v-if="isCustom" style="color: var(--accent-primary)">使用自定义模型: </span>
                                {{ value }}
                            </template>
                        </a-select>
                        <div class="hint-text">您可以从下拉列表中选择，也可以直接输入新的模型名称进行测试</div>
                    </a-form-item>

                    <a-button
                        type="primary"
                        :loading="loading"
                        :disabled="!testModel"
                        @click="handleTest"
                        block
                    >
                        开始测试
                    </a-button>
                </a-form>
            </div>

            <div v-if="result" class="test-result">
                <a-divider>测试结果</a-divider>
                <div class="result-summary">
                    <a-space direction="vertical" style="width: 100%">
                        <a-space>
                            <a-badge :status="result.success ? 'success' : 'error'" />
                            <span :class="['status-text', result.success ? 'success' : 'error']">
                                {{ result.success ? '连接成功' : '连接失败' }}
                            </span>
                            <span v-if="result.status" class="status-code">
                                HTTP {{ result.status }}
                            </span>
                            <span v-if="result.duration" class="duration">
                                耗时: {{ result.duration }}ms
                            </span>
                        </a-space>
                        <div v-if="result.url" class="result-url">
                            <span class="url-label">实际 URL:</span>
                            <code class="url-text">{{ result.url }}</code>
                        </div>
                    </a-space>
                </div>

                <div class="result-detail">
                    <div class="detail-label">响应详情:</div>
                    <pre class="response-body">{{ formattedResponse }}</pre>
                </div>
            </div>
        </div>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { testVendor } from '@/api/vendor';
import type { VendorTestResponse } from '@/api/vendor';
import { listModels } from '@/api/model';
import type { Vendor } from '@/types/vendor';
import type { Model } from '@/types/model';
import { normalizeListResponse } from '@/utils/listResponse';
import { notifyRequestError, notifySuccess, notifyWarning } from '@/utils/requestFeedback';

const visible = ref(false);
const loading = ref(false);
const format = ref('openai');
const result = ref<VendorTestResponse | null>(null);
const currentVendor = ref<Vendor | null>(null);

const testModel = ref<string>('');
const vendorModels = ref<Model[]>([]);
const modelsLoading = ref(false);
const searchValue = ref('');

// 计算下拉列表选项
const selectOptions = computed(() => {
    const options = vendorModels.value.map(m => ({
        value: m.name,
        label: m.name,
        isCustom: false,
    }));

    // 如果搜索值不在列表中，动态添加一个选项
    if (searchValue.value && !options.some(o => o.value === searchValue.value)) {
        options.unshift({
            value: searchValue.value,
            label: searchValue.value,
            isCustom: true,
        });
    }

    return options;
});

const formattedResponse = computed(() => {
    const data = result.value?.response || result.value?.error;
    if (!data) return '';
    try {
        if (typeof data === 'object') {
            return JSON.stringify(data, null, 2);
        }
        return String(data);
    } catch {
        return String(data);
    }
});

async function open(vendor: Vendor) {
    currentVendor.value = vendor;
    visible.value = true;
    result.value = null;
    testModel.value = '';
    searchValue.value = '';
    
    // 根据供应商类型预设格式
    if (vendor.type === 'anthropic') {
        format.value = 'anthropic';
    } else {
        format.value = 'openai';
    }

    // 获取该供应商下的模型
    loadVendorModels(vendor.id);
}

async function loadVendorModels(vendorId: number) {
    modelsLoading.value = true;
    try {
        vendorModels.value = normalizeListResponse(await listModels({
            vendor_id: vendorId,
            page: 1,
            pageSize: 1000,
        })).list;
        // 如果有模型，默认选中第一个
        if (vendorModels.value.length > 0) {
            testModel.value = vendorModels.value[0]?.name || '';
        }
    } catch (error) {
        notifyRequestError(error, '加载模型列表失败');
    } finally {
        modelsLoading.value = false;
    }
}

function handleSearch(val: string) {
    searchValue.value = val;
}

async function handleTest() {
    if (!currentVendor.value || !testModel.value) return;

    loading.value = true;
    result.value = null;
    try {
        const res = await testVendor(currentVendor.value.id, format.value, testModel.value);
        result.value = res;
        if (res.success) {
            notifySuccess('测试完成，连接正常');
        } else {
            notifyWarning(`测试完成，但上游返回错误 (HTTP ${res.status})`);
        }
    } catch (error) {
        const requestError = notifyRequestError(error, '测试请求发送失败');
        result.value = {
            success: false,
            error: requestError.message,
        };
    } finally {
        loading.value = false;
    }
}

defineExpose({ open });
</script>

<style scoped>
.test-dialog {
    padding: 8px 0;
}

.test-config {
    margin-bottom: 16px;
}

.hint-text {
    font-size: 12px;
    color: #8c8c8c;
    margin-top: 4px;
}

.test-result {
    margin-top: 24px;
}

.result-summary {
    margin-bottom: 16px;
    padding: 12px;
    background: #f6f8fa;
    border-radius: 4px;
}

.status-text {
    font-weight: bold;
}

.status-text.success {
    color: #52c41a;
}

.status-text.error {
    color: #ff4d4f;
}

.status-code, .duration {
    color: #8c8c8c;
    font-size: 13px;
    margin-left: 8px;
}

.result-url {
    margin-top: 8px;
    font-size: 12px;
    word-break: break-all;
    background: #f0f2f5;
    padding: 4px 8px;
    border-radius: 4px;
}

.url-label {
    color: #8c8c8c;
    margin-right: 8px;
    font-weight: 500;
}

.url-text {
    color: #595959;
    font-family: monospace;
}

.result-detail {
    margin-top: 16px;
}

.detail-label {
    font-size: 13px;
    color: #8c8c8c;
    margin-bottom: 8px;
}

.response-body {
    background: #282c34;
    color: #abb2bf;
    padding: 12px;
    border-radius: 4px;
    font-size: 12px;
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
}
</style>
